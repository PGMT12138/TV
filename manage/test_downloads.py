"""缓存验收：真实 FFmpeg 媒体、HTTP 取流、API 权限、开关与任务生命周期。"""
import asyncio
from collections import Counter
import functools
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI

import bridge
import cine
import database
import downloads
import download_engine as engine
import download_store as store
from download_transport import RawReader, DownloadError, destination


class MediaFixture:
    def __init__(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.requests = Counter()
        self.command('-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=600:sample_rate=48000',
                     '-t', '6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '48', '-c:a', 'aac', '-movflags', '+faststart', 'sample.mp4')
        for name, extra in [('hls', []), ('range', ['-hls_flags', 'single_file']), ('fmp4', ['-hls_segment_type', 'fmp4'])]:
            (self.root / name).mkdir()
            self.command('-i', 'sample.mp4', '-c', 'copy', '-hls_time', '2', '-hls_list_size', '0', *extra, f'{name}/index.m3u8')
        (self.root / 'encrypted').mkdir()
        (self.root / 'key.bin').write_bytes(b'0123456789abcdef')
        (self.root / 'keyinfo').write_text('../key.bin\n' + str(self.root / 'key.bin') + '\n')
        self.command('-i', 'sample.mp4', '-c', 'copy', '-hls_time', '2', '-hls_list_size', '0', '-hls_key_info_file', 'keyinfo', 'encrypted/index.m3u8')
        (self.root / 'audio').mkdir()
        self.command('-i', 'sample.mp4', '-vn', '-c:a', 'copy', '-hls_time', '2', '-hls_list_size', '0', 'audio/index.m3u8')
        (self.root / 'master.m3u8').write_text('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",NAME="中文",DEFAULT=YES,URI="audio/index.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=160x90,AUDIO="a"\nhls/index.m3u8\n', encoding='utf-8')
        text = (self.root / 'hls/index.m3u8').read_text()
        (self.root / 'hls/broken.m3u8').write_text(text.replace('index1.ts', 'missing.ts'))
        (self.root / 'hls/live.m3u8').write_text(text.replace('#EXT-X-ENDLIST', ''))
        (self.root / 'hls/drm.m3u8').write_text(text.replace('#EXTINF:', '#EXT-X-KEY:METHOD=SAMPLE-AES,URI="key"\n#EXTINF:', 1))
        fixture = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                path = self.path.split('?')[0]
                fixture.requests[path] += 1
                if self.headers.get('X-Media-Key') != 'fixture':
                    self.send_error(403)
                    return
                if path == '/redirect':
                    self.send_response(302); self.send_header('Location', '/hls/index.m3u8'); self.end_headers(); return
                if path == '/bad-redirect':
                    self.send_response(302); self.send_header('Location', 'http://169.254.169.254/secret'); self.end_headers(); return
                target = fixture.root / path.lstrip('/')
                if path == '/entry':
                    target = fixture.root / 'hls/index.m3u8'
                if not target.is_file():
                    self.send_error(404); return
                data = target.read_bytes()
                start, end, code = 0, len(data)-1, 200
                if self.headers.get('Range'):
                    start, end = map(int, self.headers['Range'][6:].split('-'))
                    code = 206
                self.send_response(code)
                self.send_header('Content-Type', 'application/octet-stream')
                self.send_header('Content-Length', str(end-start+1))
                if code == 206:
                    self.send_header('Content-Range', f'bytes {start}-{end}/{len(data)}')
                self.end_headers()
                self.wfile.write(data[start:end+1])

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f'http://127.0.0.1:{self.server.server_port}'

    def command(self, *args):
        subprocess.run([engine.FFMPEG, '-nostdin', '-v', 'error', '-y', *args], cwd=self.root, check=True, capture_output=True)

    def close(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(); self.temp.cleanup()


class DownloadTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        cls.media = MediaFixture()

    @classmethod
    def tearDownClass(cls):
        cls.media.close()

    async def asyncSetUp(self):
        asyncio.get_running_loop().slow_callback_duration = 2
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.manager = downloads.Manager()
        for target, attr, value in [(database, 'DB_PATH', str(self.root/'db.sqlite')), (engine, 'ROOT', self.root/'files'),
                                    (engine, 'MIN_FREE', 0), (downloads, 'manager', self.manager)]:
            p = patch.object(target, attr, value); p.start(); self.addCleanup(p.stop)
        p = patch.dict(os.environ, {'DOWNLOAD_ALLOWED_HOSTS': '127.0.0.1'}); p.start(); self.addCleanup(p.stop)
        database.init_db(); store.init(); engine.ROOT.mkdir()
        self.app = FastAPI(); self.app.include_router(cine.router); self.app.include_router(downloads.router)
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url='http://test')
        self.addAsyncCleanup(self.client.aclose)
        response = await self.client.post('/api/auth/register', json={'username':'下载用户','password':'123456'})
        self.owner = int(response.json()['user']['id'])
        self.cookie = self.client.cookies.get(cine.COOKIE_NAME)
        self.dev = bridge.Device('source-device'); self.dev.ws = object(); self.dev.fetch_flow = True
        p = patch.object(bridge, 'active_device', return_value=self.dev); p.start(); self.addCleanup(p.stop)
        self.resolve = AsyncMock(return_value={'url':self.media.url+'/sample.mp4', 'headers': {'X-Media-Key':'fixture'}})
        p = patch.object(bridge, 'call_device', self.resolve); p.start(); self.addCleanup(p.stop)
        self.source = dict(movieId='film', title='验收电影', siteKey='site', siteName='测试站', vodId='vod', flag='线路',
                           episodeId='episode-1', episodeName='第1集', episodeNumber=1)

    async def asyncTearDown(self):
        await self.manager.stop()

    async def create(self):
        response = await self.client.post('/api/downloads', json=self.source)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    async def completed(self, path='/sample.mp4'):
        self.resolve.return_value['url'] = self.media.url + path
        task = await self.create()
        await engine.Engine(store.get(task['id'])).run()
        return store.get(task['id'])

    async def test_real_file_bytes_and_range_download(self):
        task = await self.completed()
        result = await self.client.get(f"/api/downloads/{task['id']}/file")
        self.assertEqual(result.content, (self.media.root/'sample.mp4').read_bytes())
        self.assertIn('attachment', result.headers['content-disposition'])
        self.assertIn('filename*=', result.headers['content-disposition'])
        result = await self.client.get(f"/api/downloads/{task['id']}/file", headers={'Range':'bytes=10-99'})
        self.assertEqual(result.status_code, 206)
        self.assertEqual(len(result.content), 90)
        self.assertFalse(downloads._serving)

    async def test_real_hls_ts_is_complete_and_has_audio(self):
        task = await self.completed('/hls/index.m3u8')
        self.assertEqual(task['status'], 'completed')
        self.assertEqual(task['segments_done'], task['segments_total'])
        self.assertAlmostEqual(task['duration'], 6, delta=0.2)
        self.assertEqual(len(list(engine.folder(task['id']).iterdir())), 1)
        data = json.loads(subprocess.check_output([engine.FFPROBE, '-v','error','-show_streams','-of','json',str(downloads.file_path(task))]))
        self.assertEqual({s['codec_type'] for s in data['streams']}, {'video','audio'})

    async def test_real_fmp4_hls(self):
        task = await self.completed('/fmp4/index.m3u8')
        self.assertEqual(task['status'], 'completed')

    async def test_real_encrypted_hls(self):
        task = await self.completed('/encrypted/index.m3u8')
        self.assertEqual(task['status'], 'completed')
        self.assertAlmostEqual(task['duration'], 6, delta=0.2)

    async def test_real_byterange_hls(self):
        task = await self.completed('/range/index.m3u8')
        self.assertEqual(task['status'], 'completed')

    async def test_master_with_separate_audio(self):
        task = await self.completed('/master.m3u8')
        self.assertGreater(task['segments_total'], 3)
        self.assertEqual(task['status'], 'completed')

    async def test_redirect_uses_final_playlist_base(self):
        task = await self.completed('/redirect')
        self.assertEqual(task['status'], 'completed')

    async def test_no_suffix_detects_manifest_content(self):
        text = (self.media.root/'hls/index.m3u8').read_text().replace('index0.ts','hls/index0.ts').replace('index1.ts','hls/index1.ts').replace('index2.ts','hls/index2.ts')
        (self.media.root/'entry2').write_text(text)
        task = await self.completed('/entry2')
        self.assertEqual(task['status'], 'completed')

    async def test_missing_fragment_fails_and_cleans_files(self):
        self.resolve.return_value['url'] = self.media.url+'/hls/broken.m3u8'
        before = self.media.requests['/hls/missing.ts']
        task = await self.create()
        await self.manager.execute(store.get(task['id']))
        self.assertEqual(store.get(task['id'])['status'], 'failed')
        self.assertFalse(engine.folder(task['id']).exists())
        self.assertEqual(self.media.requests['/hls/missing.ts']-before, 3)

    async def test_live_and_drm_rejected(self):
        for path in ('/hls/live.m3u8','/hls/drm.m3u8'):
            self.resolve.return_value['url'] = self.media.url+path
            task = store.create(self.owner, self.dev.id, self.source)
            await self.manager.execute(task)
            self.assertEqual(store.get(task['id'])['status'], 'failed')

    async def test_duplicate_create_and_source_frozen(self):
        first, second = await self.create(), await self.create()
        self.assertEqual(first['id'], second['id'])
        self.source['episodeId']='episode-2'
        third=await self.create()
        self.assertNotEqual(first['id'], third['id'])
        self.assertEqual(store.get(first['id'])['source']['episodeId'], 'episode-1')

    async def test_device_binding_used_by_resolution(self):
        task=await self.create()
        self.dev.id='new-active-device'
        await engine.Engine(store.get(task['id'])).run()
        self.assertEqual(self.resolve.call_args.kwargs['device_id'], 'source-device')

    async def test_anonymous_and_other_user_cannot_access(self):
        task=await self.completed()
        self.client.cookies.clear()
        for method,url in [('GET','/api/downloads'),('POST','/api/downloads')]:
            r=await self.client.request(method,url,json=self.source if method=='POST' else None)
            self.assertEqual(r.status_code,401)
        await self.client.post('/api/auth/register',json={'username':'第二用户','password':'123456'})
        for method,suffix in [('GET',''),('GET','/file'),('POST','/cancel'),('POST','/retry'),('DELETE','')]:
            self.assertEqual((await self.client.request(method,f"/api/downloads/{task['id']}{suffix}")).status_code,404)

    async def test_admin_access_without_key_or_cookie(self):
        self.client.cookies.clear()
        self.assertEqual((await self.client.get('/api/admin/downloads')).status_code,200)
        self.assertEqual((await self.client.put('/api/admin/downloads/settings',json={'enabled':True})).status_code,200)
        self.assertEqual((await self.client.get('/api/downloads')).status_code,401)
        self.assertEqual((await self.client.post('/api/admin/downloads/session',json={'key':'unused'})).status_code,405)

    async def test_first_start_does_not_create_admin_secret(self):
        await self.manager.start()
        self.assertFalse((self.root / 'download-admin.key').exists())

    async def test_disable_cancels_queue_and_denies_create_retry(self):
        task=await self.create()
        r=await self.client.put('/api/admin/downloads/settings',json={'enabled':False})
        self.assertFalse(r.json()['enabled'])
        self.assertEqual(store.get(task['id'])['status'],'cancelled')
        self.assertEqual((await self.client.post('/api/downloads',json=self.source)).status_code,403)
        for prefix in ('/api/downloads','/api/admin/downloads'):
            self.assertEqual((await self.client.post(f"{prefix}/{task['id']}/retry")).status_code,403)
        self.assertFalse((await self.client.get('/api/downloads/config')).json()['enabled'])
        await self.client.put('/api/admin/downloads/settings',json={'enabled':True})
        self.assertEqual((await self.client.post(f"/api/downloads/{task['id']}/retry")).json()['status'],'queued')

    async def test_disable_cancels_running_task(self):
        started=asyncio.Event(); cancelled=asyncio.Event()
        async def run(_):
            started.set()
            try: await asyncio.Event().wait()
            finally: cancelled.set()
        await self.manager.start()
        with patch.object(engine.Engine,'run',run):
            task=await self.create(); await asyncio.wait_for(started.wait(),3)
            await self.client.put('/api/admin/downloads/settings',json={'enabled':False})
            self.assertTrue(cancelled.is_set())
            self.assertEqual(store.get(task['id'])['status'],'cancelled')

    async def test_completed_files_remain_accessible_after_disable(self):
        task=await self.completed()
        await self.client.put('/api/admin/downloads/settings',json={'enabled':False})
        self.assertEqual((await self.client.get(f"/api/downloads/{task['id']}/file")).status_code,200)
        result=await self.client.get(f"/api/admin/downloads/{task['id']}/file?preview=true")
        self.assertEqual(result.status_code,200);self.assertIn('inline',result.headers['content-disposition'])

    async def test_admin_delete_removes_file_keeps_record(self):
        task=await self.completed()
        response=await self.client.delete(f"/api/admin/downloads/{task['id']}")
        self.assertEqual(response.json()['status'],'deleted')
        self.assertFalse(engine.folder(task['id']).exists())
        self.assertEqual((await self.client.get('/api/admin/downloads')).json()['total'],1)
        self.assertEqual((await self.client.get(f"/api/downloads/{task['id']}/file")).status_code,409)

    async def test_expiry_and_missing_files(self):
        task=await self.completed();store.update(task['id'],expires_at=time.time()-1)
        await self.manager.cleanup()
        self.assertEqual(store.get(task['id'])['status'],'expired')
        task=await self.completed();engine.remove_files(task['id']);await self.manager.cleanup()
        self.assertEqual(store.get(task['id'])['status'],'missing')

    async def test_restart_marks_interrupted(self):
        task=await self.create();path=engine.folder(task['id']);path.mkdir();(path/'partial').write_bytes(b'123')
        await self.manager.start()
        self.assertEqual(store.get(task['id'])['status'],'interrupted')
        self.assertFalse(path.exists())

    async def test_size_limit_fails_without_publishing(self):
        task=await self.create()
        with patch.object(engine,'MAX_BYTES',128):
            await self.manager.execute(store.get(task['id']))
        self.assertEqual(store.get(task['id'])['status'],'failed')
        self.assertFalse(engine.folder(task['id']).exists())

    async def test_cross_origin_and_path_restrictions(self):
        r=await self.client.put('/api/admin/downloads/settings',headers={'Origin':'https://evil.test'},json={'enabled':False})
        self.assertEqual(r.status_code,403)
        with self.assertRaises(DownloadError): engine.folder('../outside')
        with self.assertRaises(DownloadError): await destination('file:///etc/passwd')
        with self.assertRaises(DownloadError): await destination('http://169.254.169.254/latest/')
        reader=RawReader(self.dev.id,{'X-Media-Key':'fixture'})
        # 普通测试服务器地址通过显式 allowlist 放行，不视为设备代理。
        with self.assertRaises(DownloadError):
            async with reader.open(self.media.url+'/bad-redirect') as _: pass

    async def test_device_stream_ack_pin_cancel_and_error(self):
        sent=[]
        class Socket:
            async def send_json(_, msg):
                sent.append(msg)
                if msg['action']=='fetch':
                    q=self.dev.streams[msg['id']]
                    q.put_nowait({'type':'meta','status':200,'headers':{},'url':'http://127.0.0.1:9978/proxy'})
                    q.put_nowait(b'abc');q.put_nowait({'type':'end'})
        self.dev.ws=Socket()
        with patch.dict(bridge._devices,{self.dev.id:self.dev}):
            reader=RawReader(self.dev.id,local=True)
            async with reader.open('http://127.0.0.1:9978/proxy') as (meta,chunks):
                self.assertEqual(b''.join([c async for c in chunks]),b'abc')
            self.assertEqual([m['action'] for m in sent],['fetch','fetchAck','cancelFetch'])
            self.assertFalse(self.dev.streams)
            self.dev.fetch_flow=False
            with self.assertRaisesRegex(DownloadError,'新版'):
                async with reader.open('http://127.0.0.1:9978/proxy') as _: pass

    async def test_device_error_frame_is_not_successful_eof(self):
        sent=[]
        class Socket:
            async def send_json(_, msg):
                sent.append(msg)
                if msg['action']=='fetch':
                    q=self.dev.streams[msg['id']]
                    q.put_nowait({'type':'meta','status':200,'headers':{}})
                    q.put_nowait(b'partial');q.put_nowait({'type':'error','error':'upstream reset'})
        self.dev.ws=Socket()
        with patch.dict(bridge._devices,{self.dev.id:self.dev}):
            reader=RawReader(self.dev.id,local=True)
            with self.assertRaisesRegex(DownloadError,'中断'):
                async with reader.open('http://127.0.0.1:9978/proxy') as (_,chunks):
                    async for _ in chunks: pass
        self.assertEqual(sent[-1]['action'],'cancelFetch')
        self.assertFalse(self.dev.streams)

    async def test_device_redirect_to_private_network_is_rejected(self):
        sent=[]
        class Socket:
            async def send_json(_, msg):
                sent.append(msg)
                if msg['action']=='fetch':
                    self.dev.streams[msg['id']].put_nowait({'type':'meta','status':302,'headers':{'Location':'http://169.254.169.254/secret'}})
        self.dev.ws=Socket()
        with patch.dict(bridge._devices,{self.dev.id:self.dev}):
            reader=RawReader(self.dev.id,local=True)
            with self.assertRaisesRegex(DownloadError,'受限'):
                async with reader.open('http://127.0.0.1:9978/proxy') as _: pass
        self.assertEqual(sum(m['action']=='fetch' for m in sent),1)

    async def test_cleanup_failure_does_not_stop_other_cleanup(self):
        task=await self.completed();store.update(task['id'],expires_at=time.time()-1)
        with patch.object(engine,'remove_files',side_effect=PermissionError('locked')):
            await self.manager.cleanup()
        self.assertIn('稍后',store.get(task['id'])['error'])
        await self.manager.cleanup()
        self.assertEqual(store.get(task['id'])['status'],'expired')

    async def test_scheduler_limits_global_and_per_user_concurrency(self):
        await self.manager.start()
        running=[]
        async def hold(instance):
            running.append(instance.task['user_id'])
            await asyncio.Event().wait()
        with patch.object(engine.Engine,'run',hold):
            for owner in [self.owner,self.owner,self.owner+1,self.owner+2]:
                store.create(owner,self.dev.id,self.source)
            for _ in range(30):
                if len(running)>=2: break
                await asyncio.sleep(.1)
            self.assertEqual(len(running),2)
            self.assertEqual(len(set(running)),2)
            self.assertEqual(len(store.by_status('queued')),2)

    async def test_empty_file_and_invalid_range_are_rejected(self):
        with self.assertRaises(DownloadError):
            engine.Engine.parse_range('20','https://example.test/a',None)
        self.assertEqual(engine.Engine.parse_range('20@5','u',None),((5,24),('u',24)))
        self.assertEqual(engine.Engine.parse_range('20','u',('u',24)),((25,44),('u',44)))
        (self.media.root/'empty.mp4').write_bytes(b'')
        self.resolve.return_value['url']=self.media.url+'/empty.mp4'
        task=await self.create();await self.manager.execute(store.get(task['id']))
        self.assertEqual(store.get(task['id'])['status'],'failed')


if __name__ == '__main__':
    unittest.main()

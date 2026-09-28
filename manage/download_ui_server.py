"""仅供端到端验收的隔离服务器，不连接真实设备或影片。"""
import asyncio
from contextlib import asynccontextmanager
import json
import os
from pathlib import Path
import socket
import sys

from fastapi import FastAPI
from fastapi.responses import HTMLResponse, FileResponse
import uvicorn

from test_downloads import MediaFixture
import bridge
import cine
import database
import downloads
import download_engine as engine


def main():
    work = Path(sys.argv[1]).resolve()
    media = MediaFixture()
    database.DB_PATH = str(work / 'test.sqlite')
    engine.ROOT = work / 'files'
    engine.MIN_FREE = 0
    os.environ['DOWNLOAD_ALLOWED_HOSTS'] = '127.0.0.1'
    database.init_db()
    device = bridge.Device('fixture-device')
    device.ws = object()
    bridge.active_device = lambda: device

    async def resolve(action, params, **kwargs):
        if params.get('id') == 'slow':
            await asyncio.sleep(30)
        return {'url':media.url+'/master.m3u8', 'headers':{'X-Media-Key':'fixture'}}
    bridge.call_device = resolve

    @asynccontextmanager
    async def lifespan(app):
        await downloads.manager.start()
        yield
        await downloads.manager.stop()
    app = FastAPI()
    app.include_router(cine.router)
    app.include_router(downloads.router)

    @app.get('/cine/', response_class=HTMLResponse)
    async def harness():
        return '<html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/tv-manage/cine/style.css"><div id="root"></div><script src="/tv-manage/cine/bundle.js"></script></html>'

    @app.get('/cine/bundle.js')
    async def bundle():
        return FileResponse(work/'bundle.js',media_type='text/javascript')

    @app.get('/cine/style.css')
    async def css():
        return FileResponse(work/'style.css',media_type='text/css')

    @app.post('/__test_shutdown')
    async def shutdown():
        server.should_exit = True
        return {'ok': True}

    root = FastAPI(lifespan=lifespan)
    root.mount('/tv-manage',app)
    sock=socket.socket();sock.bind(('127.0.0.1',0))
    print(json.dumps({'url':f'http://127.0.0.1:{sock.getsockname()[1]}/tv-manage'}),flush=True)
    server = uvicorn.Server(uvicorn.Config(root,log_level='error'))
    try:
        server.run(sockets=[sock])
    finally:
        media.close()


if __name__=='__main__':
    main()

// server/live/parser.js

export function parseLiveContent(text) {
  text = text.trim();

  // JSON format: starts with [
  if (text.startsWith('[')) {
    return JSON.parse(text);
  }

  // M3U format: contains #EXTM3U (without #genre#)
  if (text.includes('#EXTM3U') && !text.includes('#genre#')) {
    return parseM3U(text);
  }

  // TXT format: default
  return parseTxt(text);
}

function parseTxt(text) {
  const groups = [];
  let currentGroup = null;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    // Genre header: "分组名,#genre#"
    if (line.includes('#genre#')) {
      const name = line.split(',')[0].trim();
      // Check for password: "名称_密码,#genre#"
      const parts = name.split('_');
      currentGroup = {
        name: parts[0],
        pass: parts.length > 1 ? parts[parts.length - 1] : undefined,
        channel: []
      };
      groups.push(currentGroup);
      continue;
    }

    // Channel line: "频道名,URL"
    const commaIdx = line.indexOf(',');
    if (commaIdx === -1) continue;
    const chName = line.substring(0, commaIdx).trim();
    const urlPart = line.substring(commaIdx + 1).trim();

    if (!urlPart.includes('://')) continue; // directive line, skip

    if (!currentGroup) {
      currentGroup = { name: '', channel: [] };
      groups.push(currentGroup);
    }

    // Multiple URLs separated by #
    const urls = urlPart.split('#').map(u => {
      const parts = u.split('|');
      return parts[0].trim();
    }).filter(u => u.includes('://'));

    if (urls.length > 0) {
      currentGroup.channel.push({ name: chName, urls });
    }
  }

  return groups;
}

function parseM3U(text) {
  const groups = [];
  const groupMap = {};

  const lines = text.split('\n');
  let currentInfo = {};

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF:')) {
      currentInfo = parseExtInf(line);
    } else if (line.startsWith('#EXTM3U')) {
      continue;
    } else if (line.startsWith('#EXTHTTP:') || line.startsWith('#EXTVLCOPT:') || line.startsWith('#KODIPROP:')) {
      continue;
    } else if (line.includes('://')) {
      const groupName = currentInfo.group || 'Default';
      if (!groupMap[groupName]) {
        const group = { name: groupName, channel: [] };
        groupMap[groupName] = group;
        groups.push(group);
      }

      const urlParts = line.split('|');
      const url = urlParts[0].trim();

      groupMap[groupName].channel.push({
        name: currentInfo.name || url,
        urls: [url],
        logo: currentInfo.logo,
        tvgId: currentInfo.tvgId,
        tvgName: currentInfo.tvgName
      });
      currentInfo = {};
    }
  }

  return groups;
}

function parseExtInf(line) {
  const info = {};
  const commaIdx = line.lastIndexOf(',');
  if (commaIdx !== -1) info.name = line.substring(commaIdx + 1).trim();

  const attrRegex = /(\w[\w-]*)="([^"]*)"/g;
  let match;
  while ((match = attrRegex.exec(line)) !== null) {
    const key = match[1].toLowerCase();
    const val = match[2];
    if (key === 'group-title') info.group = val;
    else if (key === 'tvg-logo') info.logo = val;
    else if (key === 'tvg-id') info.tvgId = val;
    else if (key === 'tvg-name') info.tvgName = val;
  }

  return info;
}

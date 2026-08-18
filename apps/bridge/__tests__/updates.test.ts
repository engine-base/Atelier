/**
 * GAP-135: 更新チェックの unit tests — fetch を注入してフィード解釈と
 * バージョン比較を検証する。失敗系はすべて「更新なし」に倒れること。
 */

import { describe, expect, it } from 'vitest';

import {
  checkForUpdate,
  isNewerVersion,
  osKey,
  parseLatestFeed,
  type FetchLike,
} from '../src/updates.js';

describe('isNewerVersion', () => {
  it('数値 3 桁で比較する (文字列比較の 0.10.0 < 0.9.0 罠を踏まない)', () => {
    expect(isNewerVersion('0.2.0', '0.1.0')).toBe(true);
    expect(isNewerVersion('0.10.0', '0.9.0')).toBe(true);
    expect(isNewerVersion('1.0.0', '0.99.99')).toBe(true);
    expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false);
    expect(isNewerVersion('0.0.9', '0.1.0')).toBe(false);
    expect(isNewerVersion('v0.2.0', '0.1.0')).toBe(true); // v 接頭辞許容
  });

  it('解釈できない版は「新しくない」(誤アップデート通知を出さない)', () => {
    expect(isNewerVersion('latest', '0.1.0')).toBe(false);
    expect(isNewerVersion('', '0.1.0')).toBe(false);
  });
});

describe('osKey', () => {
  it('platform → フィードキー', () => {
    expect(osKey('darwin')).toBe('mac');
    expect(osKey('win32')).toBe('win');
    expect(osKey('linux')).toBe('linux');
  });
});

describe('parseLatestFeed', () => {
  it('API の {data: {...}} 包みと snake_case を受ける', () => {
    const feed = parseLatestFeed({
      data: { version: '0.2.0', download_urls: { mac: 'https://x/m.dmg', win: 'https://x/w.exe' } },
    });
    expect(feed).toEqual({
      version: '0.2.0',
      downloadUrls: { mac: 'https://x/m.dmg', win: 'https://x/w.exe' },
    });
  });

  it('version 欠落・型崩れは null', () => {
    expect(parseLatestFeed({ data: { download_urls: {} } })).toBeNull();
    expect(parseLatestFeed('nope')).toBeNull();
    expect(parseLatestFeed(null)).toBeNull();
  });
});

describe('checkForUpdate', () => {
  const feedFetch =
    (body: unknown, ok = true): FetchLike =>
    () =>
      Promise.resolve({ ok, json: () => Promise.resolve(body) });

  it('新しい版 + 自 OS の URL を返す', async () => {
    const result = await checkForUpdate('http://api.example/', {
      currentVersion: '0.1.0',
      platform: 'darwin',
      fetchLike: feedFetch({
        data: { version: '0.2.0', download_urls: { mac: 'https://dl/m.dmg' } },
      }),
    });
    expect(result).toEqual({
      updateAvailable: true,
      currentVersion: '0.1.0',
      latestVersion: '0.2.0',
      downloadUrl: 'https://dl/m.dmg',
    });
  });

  it('同版なら updateAvailable=false、自 OS の URL 未設定なら downloadUrl=null', async () => {
    const same = await checkForUpdate('http://api.example', {
      currentVersion: '0.2.0',
      platform: 'linux',
      fetchLike: feedFetch({ data: { version: '0.2.0', download_urls: {} } }),
    });
    expect(same.updateAvailable).toBe(false);
    const noUrl = await checkForUpdate('http://api.example', {
      currentVersion: '0.1.0',
      platform: 'linux',
      fetchLike: feedFetch({ data: { version: '0.2.0', download_urls: { mac: 'https://m' } } }),
    });
    expect(noUrl.updateAvailable).toBe(true);
    expect(noUrl.downloadUrl).toBeNull();
  });

  it('HTTP 失敗・例外・壊れたフィードは全て「更新なし」に倒す', async () => {
    const httpFail = await checkForUpdate('http://api.example', {
      fetchLike: feedFetch({}, false),
    });
    expect(httpFail.updateAvailable).toBe(false);
    const thrown = await checkForUpdate('http://api.example', {
      fetchLike: () => Promise.reject(new Error('offline')),
    });
    expect(thrown.updateAvailable).toBe(false);
    const broken = await checkForUpdate('http://api.example', {
      fetchLike: feedFetch({ data: { nope: 1 } }),
    });
    expect(broken.updateAvailable).toBe(false);
  });
});

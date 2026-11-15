import { describe, expect, it } from 'vitest';
import { cleanTitle, findByUrl, moveItem, normalizeBookmarkUrl, sameUrl } from '../src/main/bookmarks';

describe('bookmarks', () => {
  it('accepts only http(s) pages', () => {
    expect(normalizeBookmarkUrl(' https://example.com ')).toBe('https://example.com/');
    expect(normalizeBookmarkUrl('http://a.b/c?d=1')).toBe('http://a.b/c?d=1');
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'chrome://settings', 'not a url', '']) {
      expect(() => normalizeBookmarkUrl(bad)).toThrow();
    }
  });

  it('falls back to the host for an empty title', () => {
    expect(cleanTitle('  Новости \n дня ', 'https://x.ru')).toBe('Новости дня');
    expect(cleanTitle('', 'https://www.example.com/page')).toBe('example.com');
  });

  it('treats a trailing slash and #fragment as the same page', () => {
    expect(sameUrl('https://a.com/x/', 'https://a.com/x#top')).toBe(true);
    expect(sameUrl('https://a.com/x', 'https://a.com/y')).toBe(false);
    const items = [{ id: '1', title: 'A', url: 'https://a.com/', createdAt: 0 }];
    expect(findByUrl(items, 'https://a.com')?.id).toBe('1');
  });

  it('moves items like drag and drop does', () => {
    expect(moveItem(['a', 'b', 'c', 'd'], 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveItem(['a', 'b', 'c', 'd'], 3, 0)).toEqual(['d', 'a', 'b', 'c']);
    expect(moveItem(['a', 'b'], 0, 99)).toEqual(['b', 'a']);
    expect(moveItem(['a', 'b'], 5, 0)).toEqual(['a', 'b']);
  });
});

// Address bar input -> URL. Pure module.

export const SEARCH_URL = 'https://duckduckgo.com/?q=';

export function inputToUrl(input: string): string {
  const s = input.trim();
  if (!s) throw new Error('пустой адрес');
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(s)?.[1]?.toLowerCase();
  if (scheme === 'http' || scheme === 'https') {
    const u = new URL(s);
    return u.toString();
  }
  if (scheme && /^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    throw new Error(`адреса вида ${scheme}:// в этом браузере не открываются`);
  }
  const looksLikeHost = !/\s/.test(s) && (/^[^/?#]+\.[^/?#.]{2,}([/?#:]|$)/.test(s) || /^\[[0-9a-f:]+\]/i.test(s));
  if (looksLikeHost) {
    try {
      return new URL(`https://${s}`).toString();
    } catch {
      /* fall through to search */
    }
  }
  return SEARCH_URL + encodeURIComponent(s);
}

const ERRORS: Record<number, string> = {
  [-20]: 'Запрос заблокирован: туннель не подключён или адрес локальный.',
  [-21]: 'Сеть изменилась, попробуйте ещё раз.',
  [-105]: 'Сайт не найден.',
  [-106]: 'Нет подключения к интернету.',
  [-111]: 'Сервер VPN не смог открыть соединение с сайтом.',
  [-118]: 'Сайт не ответил вовремя.',
  [-130]: 'Туннель недоступен: запрос не ушёл в интернет.',
  [-200]: 'Сертификат сайта недействителен.',
  [-201]: 'Сертификат сайта просрочен.',
  [-202]: 'Сертификат сайта выдан неизвестным центром.',
  [-324]: 'Сайт закрыл соединение без ответа.',
};

export function loadErrorText(code: number, description: string): string {
  return ERRORS[code] ?? `Не удалось открыть страницу (${description || code}).`;
}

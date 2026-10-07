// Plain, deterministic buttons. No callback contains credentials or signing state.
export const menuButton = (text, destination) => ({ text, callback_data: `tg:menu:${destination}` });
export const MAIN_MENU = Object.freeze([
  [menuButton('Projects', 'projects'), menuButton('My alerts', 'alerts')],
  [menuButton('Look up token / hook', 'lookup'), menuButton('Wallet', 'wallet')],
  [menuButton('Settings', 'settings'), menuButton('Help', 'help')],
  [{ text: 'Open Hookline', url: 'https://hookline.world/#/board' }],
]);
export function navigationRows() {
  return [[menuButton('My alerts', 'alerts'), menuButton('Projects', 'projects')], [menuButton('Main menu', 'main')]];
}
export function alertNavigationRows() {
  return [[menuButton('Add alert', 'add'), menuButton('Projects', 'projects')], [menuButton('Main menu', 'main')]];
}
export function privateConversation(chatId, userId, fromId = userId) {
  return /^[1-9][0-9]{0,19}$/.test(String(userId)) && String(chatId) === String(userId) && String(fromId) === String(userId);
}
export function cleanLabel(value, max = 90) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\b(?:[a-z][a-z\d+.-]*:\/\/|www\.)\S+/gi, 'link removed')
    .replace(/\b(?:[a-z\d-]+\.)+[a-z]{2,}(?:\/\S*)?/gi, 'link removed')
    .trim().slice(0, max) : '';
}
export function markdownText(value) {
  return cleanLabel(value, 250).replace(/[_*`\[\]\\]/g, '');
}
export function htmlText(value) {
  return String(value ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
// Addresses are a separate line so Telegram exposes tap-to-copy code text.
// Every other line is escaped, including project names supplied by contributors.
export function alertHtml(lines) {
  return lines.map(line=>line && typeof line==='object' && 'address' in line
    ? `<code>${htmlText(line.address)}</code>` : htmlText(line)).join('\n');
}

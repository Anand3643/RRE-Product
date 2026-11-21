/** XML escaping for text nodes and attribute values (names such as "Plant & Machinery" are common). */
function xmlEsc(v) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '') // characters illegal in XML 1.0
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
module.exports = { xmlEsc };

// parse.js — a fast CommonMark + GitHub Flavored Markdown renderer.
//
// parse(markdown) returns exactly the HTML that marked 18.1.3 renders with
// its default options (GFM on, hard breaks off, pedantic off, async off).
// The matching patterns and the parsing decisions below follow marked
// 18.1.3 (MIT, (c) Christopher Jeffrey and contributors; see NOTICE.md) —
// reimplemented here as one direct-rendering pass: blocks are recognised by
// a first-character dispatch instead of trying every rule in turn, and
// inline text is scanned for the next construct start instead of running
// every inline rule at every position. Nothing is cached or recognised
// across calls: every call parses only the string it is given, with fresh
// state, and returns only what that string renders to.

const ESCAPE_REPLACEMENTS = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(html, encode) {
  if (encode) {
    if (O_escapeTest.test(html)) {
      return html.replace(O_escapeReplace, (ch) => ESCAPE_REPLACEMENTS[ch]);
    }
  } else if (O_escapeTestNoEncode.test(html)) {
    return html.replace(O_escapeReplaceNoEncode, (ch) => ESCAPE_REPLACEMENTS[ch]);
  }
  return html;
}

// Numeric character references are recognised outside code and stand for
// the character they name. Values that are zero, out of range, or a
// surrogate become the replacement character.
function decodeNumericCharacterReferences(text) {
  if (!O_numericCharacterReference.test(text)) {
    return text;
  }
  // A decoded character must not join its neighbours into a new reference,
  // so every `&` that is not already one is escaped here.
  return text.replace(O_numericCharacterReferenceOrAmpersand, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) {
      return '&amp;';
    }
    const code = dec === undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
      return '\uFFFD';
    }
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(O_percentDecode, '%');
  } catch {
    return null;
  }
  return href;
}

function splitCells(tableRow, count) {
  // Ensure that every cell-delimiting pipe has a space before it, to
  // distinguish it from an escaped pipe.
  const row = tableRow.replace(O_findPipe, (match, offset, str) => {
    let escaped = false;
    let curr = offset;
    while (--curr >= 0 && str[curr] === '\\') escaped = !escaped;
    if (escaped) {
      return '|';
    }
    return ' |';
  });
  const cells = row.split(O_splitPipe);
  let i = 0;

  // First/last cell in a row cannot be empty if it has no leading/trailing pipe.
  if (!cells[0].trim()) {
    cells.shift();
  }
  if (cells.length > 0 && !cells.at(-1)?.trim()) {
    cells.pop();
  }

  if (count) {
    if (cells.length > count) {
      cells.splice(count);
    } else {
      while (cells.length < count) cells.push('');
    }
  }

  for (; i < cells.length; i++) {
    // Leading or trailing whitespace is ignored per the GFM spec.
    cells[i] = cells[i].trim().replace(O_slashPipe, '|');
  }
  return cells;
}

// Remove trailing 'c's. Equivalent to str.replace(/c*$/, '').
function rtrim(str, c, invert) {
  const l = str.length;
  if (l === 0) {
    return '';
  }
  let suffLen = 0;
  while (suffLen < l) {
    const currChar = str.charAt(l - suffLen - 1);
    if (currChar === c && !invert) {
      suffLen++;
    } else if (currChar !== c && invert) {
      suffLen++;
    } else {
      break;
    }
  }
  return str.slice(0, l - suffLen);
}

function trimTrailingBlankLines(str) {
  // Remove trailing blank lines, keeping a single one. Same result as
  // splitting into lines and dropping the trailing blank ones, but without
  // building the array: only the tail of the string is scanned.
  let end = str.length;
  let trailing = 0;
  while (true) {
    let ls = end - 1;
    while (ls >= 0 && str[ls] !== '\n') ls--;
    ls++;
    let j = ls;
    while (j < end && (str[j] === ' ' || str[j] === '\t')) j++;
    if (j !== end) break;
    trailing++;
    if (ls === 0) { end = 0; break; }
    end = ls - 1;
  }
  if (trailing <= 1) {
    // We want to keep single trailing blank lines.
    return str;
  }
  return str.slice(0, end);
}

// Normalises a link label so definitions and references can be matched.
// CommonMark asks for a Unicode case fold, which `toLowerCase()` does not
// reach: `ẞ` lowercases to `ß` and so never meets `SS`. Round-tripping
// through upper case does, as in commonmark.js; the final `toLowerCase()`
// keeps the folded label lower case.
function normalizeLabel(label) {
  return label.trim().replace(O_multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}

function findClosingBracket(str, b) {
  // An opening bracket on its own is still unbalanced, so both have to be absent.
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) {
    return -1;
  }
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') {
      i++;
    } else if (str[i] === b[0]) {
      level++;
    } else if (str[i] === b[1]) {
      level--;
      if (level < 0) {
        return i;
      }
    }
  }
  if (level > 0) {
    return -2;
  }
  return -1;
}

function expandTabs(line, indent) {
  let col = indent || 0;
  let expanded = '';
  for (const char of line) {
    if (char === '\t') {
      const added = 4 - (col % 4);
      expanded += ' '.repeat(added);
      col += added;
    } else {
      expanded += char;
      col++;
    }
  }
  return expanded;
}

// --- Indent-sensitive patterns, cached per indent (0..3) as in the reference ---

function cachedIndentRegex(createRegex) {
  const cache = [];
  return (indent) => {
    const cacheIndex = Math.max(0, Math.min(3, indent - 1));
    let regex = cache[cacheIndex];
    if (!regex) {
      regex = createRegex(cacheIndex);
      cache[cacheIndex] = regex;
    }
    return regex;
  };
}

const TAG_NAMES = 'address|article|aside|base|basefont|blockquote|body|caption'
  + '|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption'
  + '|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe'
  + '|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option'
  + '|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title'
  + '|tr|track|ul';

function listItemRegex(bull) {
  return new RegExp(`^( {0,3}${bull})((?:[\t ][^\\n]*)?(?:\\n|$))`);
}
const nextBulletRegex = cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`));
const hrRegex = cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`));
const fencesBeginRegex = cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}(?:\`\`\`|~~~)`));
const headingBeginRegex = cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}#{1,6}(?:\\s|$)`));
const htmlBeginRegex = cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}(?:</?(?:${TAG_NAMES})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'));
const blockquoteBeginRegex = cachedIndentRegex((indent) => new RegExp(`^ {0,${indent}}>`));

// Does the line at the start of `s` begin an indented code block (four
// spaces, or up to three spaces and a tab)?
function startsIndentedCode(s) {
  let k = 0;
  while (k < 3 && s.charCodeAt(k) === 32) k++;
  if (s.charCodeAt(k) === 9) return true;
  return k === 3 && s.charCodeAt(3) === 32;
}
// --- Pattern tables: the exact matching patterns of the reference renderer,
// --- collected here so the parser below can dispatch on them directly. ---
const B_newline = new RegExp("^(?:[ \\t]*(?:\\n|$))+", "");
const B_code = new RegExp("^((?: {4}| {0,3}\\t)[^\\n]+(?:\\n(?:[ \\t]*(?:\\n|$))*)?)+", "");
const B_fences = new RegExp("^ {0,3}(`{3,}(?=[^`\\n]*(?:\\n|$))|~{3,})([^\\n]*)(?:\\n|$)(?:|([\\s\\S]*?)(?:\\n|$))(?: {0,3}(?:(?=`)\\1`*|(?=~)\\1~*) *(?=\\n|$)|$)", "");
const B_heading = new RegExp("^ {0,3}(#{1,6})(?=\\s|$)(.*)(?:\\n+|$)", "");
const B_hr = new RegExp("^ {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)", "");
const B_lheading = new RegExp("^(?! {0,3}(?:[*+-]|\\d{1,9}[.)]) |(?: {4}| {0,3}\\t)| {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\\s|$)| {0,3}<[^\\n>]+>\\n| {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n)((?:.|\\n(?!\\s*?\\n| {0,3}(?:[*+-]|\\d{1,9}[.)]) | {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}(?:\\s|$)| {0,3}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)| {0,3}<[^\\n>]+>\\n| {0,3}\\|?(?:[:\\- ]*\\|)+[\\:\\- ]*\\n))+?)\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)", "");
const B_paragraph = new RegExp("^([^\\n]+(?:\\n(?! {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)| {0,3}#{1,6}(?:\\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)| {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]| {0,3}(?:<\\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\\n|\\/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)| *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n| {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)| {0,3}#{1,6}(?:\\s|$)| {0,3}>|(?: {4}| {0,3}\t)[^\\n]| {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)| {0,3}(?:[*+-]|1[.)])[ \\t]| {0,3}(?:<\\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\\n|\\/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)).*(?:\\n|$))*)\\n*|$)|[ \\t]+\\n)[^\\n]+)*)", "");
const B_blockquote = new RegExp("^( {0,3}> ?(?:(?![ \\t]*(?:\\n|$))(([^\\n]+(?:\\n(?! {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)| {0,3}#{1,6}(?:\\s|$)| {0,3}>| {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)| {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)| {0,3}(?:<\\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\\n|\\/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)|[ \\t]+\\n)[^\\n]+)*))|[^\\n]*)(?:\\n|$))+", "");
const B_list = new RegExp("^( {0,3}(?:[*+-]|\\d{1,9}[.)]))([ \\t][^\\n]*?)?(?:\\n|$)", "");
const B_html = new RegExp("^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:<\\/\\1>[^\\n]*\\n*|$)|<!--(?:-?>|[\\s\\S]*?(?:-->|$))[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|<\\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \\t]+|\\n|\\/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\\w.:-]*(?: *= *\"[^\"\\n]*\"| *= *'[^'\\n]*'| *= *[^\\s\"'=<>`]+)?)*? *\\/?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<\\/[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))", "i");
const B_def = new RegExp("^ {0,3}\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+)\\]: *(?:\\n[ \\t]*)?([^<\\s][^\\s]*|<.*?>)(?:(?: +(?:\\n[ \\t]*)?| *\\n[ \\t]*)((?:\"(?:\\\\[\\s\\S]|[^\"\\\\])*\"|'(?:\\\\[\\s\\S]|[^'\\\\\\n]|\\n(?!\\n))*'|\\((?:\\\\[\\s\\S]|[^()\\\\])*\\))))? *(?:\\n+|$)", "");
const B_table = new RegExp("^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n| {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)| {0,3}#{1,6}(?:\\s|$)| {0,3}>|(?: {4}| {0,3}\t)[^\\n]| {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)| {0,3}(?:[*+-]|1[.)])[ \\t]| {0,3}(?:<\\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\\n|\\/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)).*(?:\\n|$))*)\\n*|$)", "");
const B_text = new RegExp("^[^\\n]+", "");
const I_escape = new RegExp("^\\\\([!\"#$%&'()*+,\\-./:;<=>?@\\[\\]\\\\^_`{|}~])", "");
const I_code = new RegExp("^(`+)([^`]|[^`][\\s\\S]*?[^`])\\1(?!`)", "");
const I_br = new RegExp("^( {2,}|\\\\)\\n(?!\\s*$)[ \\t]*", "");
const I_text = new RegExp("^(?:[^a-zA-Z0-9](?=(?:mailto|xmpp):)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\\n)|(?=[a-zA-Z0-9.!#$%&'*+\\/=?_`{\\|}~-]+@)|[\\s\\S]*?(?:(?=[\\\\<!\\[`*~_]|\\b_|[hH][tT][tT][pP][sS]?|[fF][tT][pP]:\\/\\/|(?<![^\\s*_~(])www\\.|$)|[^ ](?= {2,}\\n)|[^a-zA-Z0-9](?=(?:mailto|xmpp):)|[^a-zA-Z0-9.!#$%&'*+\\/=?_`{\\|}~-](?=[a-zA-Z0-9.!#$%&'*+\\/=?_`{\\|}~-]+@))))", "");
const I_autolink = new RegExp("^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\\s\\x00-\\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>", "");
const I_tag = new RegExp("^<!--(?:-?>|[\\s\\S]*?-->)|^<\\/[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\\s+[a-zA-Z:_][\\w.:-]*(?:\\s*=\\s*\"[^\"]*\"|\\s*=\\s*'[^']*'|\\s*=\\s*[^\\s\"'=<>`]+)?)*?\\s*\\/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>", "");
const I_link = new RegExp("^!?\\[((?:\\[(?:\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?)\\]\\([ \\t\\n]*(<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\)))(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)(\"(?:\\\\[\\s\\S]|[^\"\\\\])*\"|'(?:\\\\[\\s\\S]|[^'\\\\])*'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)))?[ \\t\\n]*\\)", "");
const I_reflink = new RegExp("^!?\\[((?:\\[(?:\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?)\\]\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+)\\]", "");
const I_nolink = new RegExp("^!?\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+)\\](?:\\[\\])?", "");
const I_reflinkSearch = new RegExp("!?\\[((?:[^\\[\\]\\\\`]*(?:\\[(?:\\[(?:\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\]))){0,999}?[^\\[\\]\\\\`]*?)\\]\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999})\\]|!?\\[((?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999})\\](?:\\[\\])?(?!\\()", "g");
const I_url = new RegExp("^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])(?:\\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\\/\\/|www\\.)(?:[a-zA-Z0-9\\-]+\\.?)+[^\\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\\w-])", "");
const I__backpedal = new RegExp("(?:[^?!.,:;*_'\"~()&]+|\\([^)]*\\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+", "");
const I_del = new RegExp("^(~~?)(?=[^\\s~])((?:\\\\[\\s\\S]|[^\\\\])*?(?:\\\\[\\s\\S]|[^\\s~\\\\]))\\1(?=[^~]|$)", "");
const I_delLDelim = new RegExp("^~~?(?:((?!~)[\\p{P}\\p{S}])|[^\\s~])", "u");
const I_delRDelim = new RegExp("^[^~]+(?=[^~])|(?!~)[\\p{P}\\p{S}](~~?)(?=[\\s]|$)|[^\\s\\p{P}\\p{S}](~~?)(?!~)(?=[\\s\\p{P}\\p{S}]|$)|(?!~)[\\s\\p{P}\\p{S}](~~?)(?=[^\\s\\p{P}\\p{S}])|[\\s](~~?)(?!~)(?=[\\p{P}\\p{S}])|(?!~)[\\p{P}\\p{S}](~~?)(?!~)(?=[\\p{P}\\p{S}])|[^\\s\\p{P}\\p{S}](~~?)(?=[^\\s\\p{P}\\p{S}])", "gu");
const I_emStrongLDelim = new RegExp("^(?:\\*+(?:((?!\\*)(?!~)[\\p{P}\\p{S}])|([^\\s*]))?)|^_+(?:((?!_)(?!~)[\\p{P}\\p{S}])|([^\\s_]))?", "u");
const I_emStrongRDelimAst = new RegExp("^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)(?!~)[\\p{P}\\p{S}](\\*+)(?=[\\s]|$)|(?:[^\\s\\p{P}\\p{S}]|~)(\\*+)(?!\\*)(?=(?!~)[\\s\\p{P}\\p{S}]|$)|(?!\\*)(?!~)[\\s\\p{P}\\p{S}](\\*+)(?=(?:[^\\s\\p{P}\\p{S}]|~))|[\\s](\\*+)(?!\\*)(?=(?!~)[\\p{P}\\p{S}])|(?!\\*)(?!~)[\\p{P}\\p{S}](\\*+)(?!\\*)(?=(?!~)[\\p{P}\\p{S}])|(?:[^\\s\\p{P}\\p{S}]|~)(\\*+)(?=(?:[^\\s\\p{P}\\p{S}]|~))", "gu");
const I_emStrongRDelimUnd = new RegExp("^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)[\\p{P}\\p{S}](_+)(?=[\\s]|$)|[^\\s\\p{P}\\p{S}](_+)(?!_)(?=[\\s\\p{P}\\p{S}]|$)|(?!_)[\\s\\p{P}\\p{S}](_+)(?=[^\\s\\p{P}\\p{S}])|[\\s](_+)(?!_)(?=[\\p{P}\\p{S}])|(?!_)[\\p{P}\\p{S}](_+)(?!_)(?=[\\p{P}\\p{S}])", "gu");
const I_blockSkip = new RegExp("\\[(?:[^\\[\\]`]|(?<a>`+)[^`]+\\k<a>(?!`))*?\\]\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)]|\\((?:\\\\[\\s\\S]|[^\\\\\\(\\)])*\\))*\\)|(?<!`)()(?<b>`+)[^`]+\\k<b>(?!`)|<(?! )[^<>]*?>", "g");
const I_anyPunctuation = new RegExp("\\\\([\\p{P}\\p{S}])", "gu");
const I_anyPunctuationOutsideCode = new RegExp("(`+)(?:[^`]|[^`][\\s\\S]*?[^`])\\1(?!`)|`+|\\\\([\\p{P}\\p{S}])", "gu");
const I_punctuation = new RegExp("^((?![*_])[\\s\\p{P}\\p{S}])", "u");
const O_codeRemoveIndent = new RegExp("^(?: {0,3}\\t| {1,4})", "gm");
const O_outputLinkReplace = new RegExp("\\\\([\\[\\]])", "g");
const O_indentCodeCompensation = new RegExp("^(\\s+)(?:```)", "");
const O_beginningSpace = new RegExp("^\\s+", "");
const O_endingHash = new RegExp("#$", "");
const O_startingSpaceChar = new RegExp("^ ", "");
const O_endingSpaceChar = new RegExp(" $", "");
const O_endingSpaceTabChar = new RegExp("[ \\t]$", "");
const O_nonSpaceChar = new RegExp("[^ ]", "");
const O_newLineCharGlobal = new RegExp("\\n", "g");
const O_tabCharGlobal = new RegExp("\\t", "g");
const O_leadingSpaceTab = new RegExp("^[ \\t]+", "");
const O_multipleSpaceGlobal = new RegExp("\\s+", "g");
const O_blankLine = new RegExp("^[ \\t]*$", "");
const O_blockquoteStart = new RegExp("^ {0,3}>", "");
const O_blockquoteSetextReplace = new RegExp("\\n {0,3}((?:=+|-+)[ \\t]*)(?=\\n|$)", "g");
const O_blockquoteSetextReplace2 = new RegExp("^ {0,3}>[ \\t]?", "gm");
const O_blockquoteMarkerWhitespace = new RegExp("^( {0,3}>)([ \\t]+)", "gm");
const O_listReplaceNesting = new RegExp("^ {1,4}(?=( {4})*[^ ])", "g");
const O_listIsTask = new RegExp("^\\[[ xX]\\][ \\t]+\\S", "");
const O_listReplaceTask = new RegExp("^\\[[ xX]\\][ \\t]+", "");
const O_listTaskCheckbox = new RegExp("\\[[ xX]\\]", "");
const O_anyLine = new RegExp("\\n.*\\n", "");
const O_hrefBrackets = new RegExp("^<(.*)>$", "");
const O_tableDelimiter = new RegExp("[:|]", "");
const O_tableAlignChars = new RegExp("^\\||\\| *$", "g");
const O_tableRowBlankLine = new RegExp("\\n[ \\t]*$", "");
const O_tableAlignRight = new RegExp("^ *-+: *$", "");
const O_tableAlignCenter = new RegExp("^ *:-+: *$", "");
const O_tableAlignLeft = new RegExp("^ *:-+ *$", "");
const O_startATag = new RegExp("^<a ", "i");
const O_endATag = new RegExp("^<\\/a>", "i");
const O_startPreScriptTag = new RegExp("^<(pre|code|kbd|script)(\\s|>)", "i");
const O_endPreScriptTag = new RegExp("^<\\/(pre|code|kbd|script)(\\s|>)", "i");
const O_startAngleBracket = new RegExp("^<", "");
const O_endAngleBracket = new RegExp(">$", "");
const O_pedanticHrefTitle = new RegExp("^([^'\"]*[^\\s])\\s+(['\"])(.*)\\2", "");
const O_unicodeAlphaNumeric = new RegExp("[\\p{L}\\p{N}]", "u");
const O_numericCharacterReference = new RegExp("&#(?:(\\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));", "");
const O_numericCharacterReferenceOrAmpersand = new RegExp("&#(?:(\\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\\w+);)", "g");
const O_escapeTest = new RegExp("[&<>\"']", "");
const O_escapeReplace = new RegExp("[&<>\"']", "g");
const O_escapeTestNoEncode = new RegExp("[<>\"']|&(?!(#\\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\\w+);)", "");
const O_escapeReplaceNoEncode = new RegExp("[<>\"']|&(?!(#\\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\\w+);)", "g");
const O_caret = new RegExp("(^|[^\\[])\\^", "g");
const O_percentDecode = new RegExp("%25", "g");
const O_findPipe = new RegExp("\\|", "g");
const O_splitPipe = new RegExp(" \\|", "");
const O_slashPipe = new RegExp("\\\\\\|", "g");
const O_carriageReturn = new RegExp("\\r\\n|\\r", "g");
const O_spaceLine = new RegExp("^ +$", "gm");
const O_notSpaceStart = new RegExp("^\\S*", "");
const O_endingNewline = new RegExp("\\n$", "");

// =====================================================================
// Inline rendering: one scan that writes HTML directly, instead of
// building an inline token tree and walking it again.
// =====================================================================

function newCtx() {
  return {
    links: Object.create(null),
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    linkParenPossible: true,
    top: true,
    queue: [],
    closerStack: [],
  };
}

// Next position after `i` where an inline construct could start, or the end
// of the string. Anything before that is plain text, and emitting it whole
// renders exactly as the reference's text tokens do.
// One scan finds the next position the inline loop must stop at: a special
// character, a hard-break run, or the start of a bare URL / email address.
const NEXT_CANDIDATE = /[\\`<\[*_~]|!(?=\[)| {2,}\n|www\.|:\/\/|@/g;

// Whether the remaining text holds a setext underline before the next blank
// line (which ends the paragraph): a line of 0–3 spaces, a run of `=` or
// `-`, then only spaces/tabs to the end of the line. A cheap line scan that
// stands in for the setext-heading regex when no underline can be there.
function hasSetextUnderline(s) {
  const cut = s.indexOf('\n\n');
  const end = cut === -1 ? s.length : cut;
  let i = s.indexOf('\n');
  while (i !== -1 && i < end) {
    let j = i + 1;
    while (j < end && s.charCodeAt(j) === 32 && j - (i + 1) < 3) j++;
    const c = s.charCodeAt(j);
    if (c === 61 || c === 45) { // '=' or '-'
      let k = j;
      while (k < end && s.charCodeAt(k) === c) k++;
      while (k < end && (s.charCodeAt(k) === 32 || s.charCodeAt(k) === 9)) k++;
      if (k === end || s.charCodeAt(k) === 10) return true;
    }
    i = s.indexOf('\n', i + 1);
  }
  return false;
}

// Whether the text ends with a blank line preceded by another blank line:
// the `/\n[ \t]*\n[ \t]*$/` test, as a backward scan of the tail.
function endsWithDoubleBlankLine(raw) {
  let i = raw.length;
  while (i > 0 && (raw[i - 1] === ' ' || raw[i - 1] === '\t')) i--;
  if (i === 0 || raw[i - 1] !== '\n') return false;
  i--;
  while (i > 0 && (raw[i - 1] === ' ' || raw[i - 1] === '\t')) i--;
  if (i === 0 || raw[i - 1] !== '\n') return false;
  return true;
}

function isEmailCharCode(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122)
    || c === 46 || c === 95 || c === 43 || c === 45;
}

// Whitespace, `*`, `_`, `~` or `(`: the characters that may precede `www.`
// for it to start an extended autolink.
function isWwwPreceding(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13
    || c === 42 || c === 95 || c === 126 || c === 40;
}

// Cheap pre-check before the big URL regex: whether a URL could start at
// `i` at all. A superset of the URL rule's match conditions, so it never
// says no when the rule could match.
function urlMayMatch(src, i) {
  const c = src.charCodeAt(i);
  if (c === 119 && src.startsWith('www.', i)) return true; // 'w'
  if (c === 104 || c === 72) { // 'h' 'H'
    const t = src.slice(i, i + 8).toLowerCase();
    if (t.startsWith('http://') || t.startsWith('https://')) return true;
  }
  if (c === 102 || c === 70) { // 'f' 'F'
    if (src.slice(i, i + 6).toLowerCase().startsWith('ftp://')) return true;
  }
  if (c === 109 || c === 120) { // 'm' 'x'
    const t = src.slice(i, i + 7).toLowerCase();
    if (t.startsWith('mailto:') || t.startsWith('xmpp:')) return true;
  }
  // Email: a run of address characters followed by '@'.
  if (isEmailCharCode(c)) {
    let j = i + 1;
    while (j < src.length && isEmailCharCode(src.charCodeAt(j))) j++;
    if (src.charCodeAt(j) === 64) return true; // '@'
  }
  return false;
}

function nextCandidate(src, i) {
  const n = src.length;
  NEXT_CANDIDATE.lastIndex = i + 1;
  let m;
  while ((m = NEXT_CANDIDATE.exec(src))) {
    const j = m.index;
    const hit = m[0];
    if (hit === 'www.') {
      // The reference text only stops before `www.` when the preceding
      // character is whitespace, `*`, `_`, `~` or `(` (its wwwStart
      // lookbehind); otherwise the `www.` is plain text.
      if (isWwwPreceding(src.charCodeAt(j - 1))) return j;
      continue;
    }
    if (hit === '://') {
      let start = -1;
      if (j >= 3 && src.slice(j - 3, j).toLowerCase() === 'ftp') start = j - 3;
      else if (j >= 4 && src.slice(j - 4, j).toLowerCase() === 'http') start = j - 4;
      else if (j >= 5 && src.slice(j - 5, j).toLowerCase() === 'https') start = j - 5;
      if (start !== -1 && start > i) return start;
      continue;
    }
    if (hit === '@') {
      // An email address starts at the beginning of the run of address
      // characters before an `@`.
      let st = j;
      while (st > i + 1 && isEmailCharCode(src.charCodeAt(st - 1))) st--;
      if (st > i && st < j) return st;
      continue;
    }
    return j;
  }
  return n;
}

// A text run with no `&`, `<`, `>`, `"` or `'` needs neither decoding nor
// escaping, so it can be pushed as it is.
const O_textNeedsWork = /[&<>\"']/;
function emitText(ctx, src, i, j, plain, out) {
  const run = src.slice(i, j);
  if (ctx.inRawBlock || !O_textNeedsWork.test(run)) {
    out.push(run);
    return;
  }
  const dec = decodeNumericCharacterReferences(run);
  out.push(plain ? dec : escapeHtml(dec, false));
}

// Last indexes of `*` / `_` runs that can close emphasis or strong, and of
// a `~` run that can close strikethrough, in one scan of the masked source.
function scanClosers(src) {
  let ast = -1;
  let und = -1;
  let del = -1;
  const len = src.length;
  for (let i = 0; i < len; i++) {
    const ch = src[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') {
      continue;
    }
    const prev = i === 0 ? '\n' : src[i - 1];
    let j = i + 1;
    while (j < len && src[j] === ch) {
      j++;
    }
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') {
        del = i;
      } else if (ch === '*') {
        ast = i;
      } else {
        und = i;
      }
    }
    i = j - 1;
  }
  return { ast, und, del };
}

// Does this link text hold a link already? An image does not count: an image
// may hold a link, a link may not.
function linkInText(ctx, text) {
  if (!text.includes('[')) {
    return false;
  }
  for (const match of text.matchAll(I_blockSkip)) {
    if (I_link.test(match[0]) && text.charAt(match.index - 1) !== '!') {
      return true;
    }
  }
  for (const match of text.matchAll(I_reflinkSearch)) {
    const match0 = match[0];
    const refStart = match0.lastIndexOf('[');
    if (match0.charAt(0) === '!' || !Object.hasOwn(ctx.links, normalizeLabel(match0.slice(refStart + 1, -1)))) {
      continue;
    }
    // A candidate holding a link is not a link either, so it does not count.
    if (refStart > 1 && linkInText(ctx, match0.slice(1, refStart - 1))) {
      continue;
    }
    return true;
  }
  return false;
}

// Mask links, code, html and escapes so emStrong and del do not see their
// delimiters inside them.
function maskSrc(ctx, src) {
  let maskedSrc = src;

  // Mask out reflinks.
  if (ctx.links && src.includes('[')) {
    const maskReflink = (match0) => {
      const refStart = match0.lastIndexOf('[');
      if (!Object.hasOwn(ctx.links, normalizeLabel(match0.slice(refStart + 1, -1)))) {
        return match0;
      }
      // CommonMark: "Links may not contain other links, at any level of
      // nesting." A candidate whose text already holds one never becomes a
      // link, so flattening the whole span would hide the emphasis that
      // does still apply inside it. Mask the links it holds instead.
      // Images are exempt: their text is flattened into an alt attribute.
      if (refStart > 1 && match0.charAt(0) !== '!') {
        const text = match0.slice(1, refStart - 1);
        if (linkInText(ctx, text)) {
          return '[' + text.replace(I_reflinkSearch, maskReflink)
            + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match0.length - 2) + ']';
    };
    maskedSrc = maskedSrc.replace(I_reflinkSearch, maskReflink);
  }

  // Mask out escaped characters. Every mask keeps the length it replaces:
  // emStrong and del line the masked source up with the real one by slicing
  // from the end. A backslash inside a code span is literal, not an escape.
  maskedSrc = maskedSrc.replace(I_anyPunctuationOutsideCode, (match0, code, punct) => {
    if (punct) {
      return '+'.repeat(match0.length);
    }
    if (code) {
      return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
    }
    return match0;
  });

  // Mask out other blocks.
  maskedSrc = maskedSrc.replace(I_blockSkip, (match0, _link, context) => {
    const offset = context ? context.length : 0;
    return match0.slice(0, offset) + '[' + 'a'.repeat(match0.length - offset - 2) + ']';
  });

  return maskedSrc;
}

function renderInline(ctx, src, plain) {
  const prevParen = ctx.linkParenPossible;
  ctx.linkParenPossible = prevParen && src.includes(')');
  try {
    return renderInlineInner(ctx, src, plain);
  } finally {
    ctx.linkParenPossible = prevParen;
  }
}

function renderInlineInner(ctx, src, plain) {
  // The masked source is only read by emStrong and del, which need a `*`,
  // `_` or `~` to start, and the mask only changes runs that hold a link,
  // code span, HTML tag or escape. Skip building it for a run without both.
  const needMask = (src.includes('*') || src.includes('_') || src.includes('~'))
    && (src.includes('[') || src.includes('`') || src.includes('<') || src.includes('\\'));
  const masked = needMask ? maskSrc(ctx, src) : src;
  const frame = scanClosers(masked);
  ctx.closerStack.push(frame);
  try {
    return scanInline(ctx, src, masked, plain);
  } finally {
    ctx.closerStack.pop();
  }
}

// Each handler below renders the construct at `src[i]` (or returns -1 when
// it does not start one), appending HTML to `out` and returning the index
// just past it. Returning -2 means "one character of plain text".

function inlineEscape(ctx, src, i, plain, out) {
  const cap = I_escape.exec(src.slice(i));
  if (!cap) return -1;
  out.push(plain ? cap[1] : escapeHtml(cap[1], false));
  return i + cap[0].length;
}

function inlineTag(ctx, src, i, plain, out) {
  const cap = I_tag.exec(src.slice(i));
  if (!cap) return -1;
  if (!ctx.inLink && O_startATag.test(cap[0])) {
    ctx.inLink = true;
  } else if (ctx.inLink && O_endATag.test(cap[0])) {
    ctx.inLink = false;
  }
  if (!ctx.inRawBlock && O_startPreScriptTag.test(cap[0])) {
    ctx.inRawBlock = true;
  } else if (ctx.inRawBlock && O_endPreScriptTag.test(cap[0])) {
    ctx.inRawBlock = false;
  }
  out.push(cap[0]);
  return i + cap[0].length;
}

function inlineCodespan(ctx, src, i, plain, out) {
  const cap = I_code.exec(src.slice(i));
  if (!cap) return -1;
  let text = cap[2].replace(O_newLineCharGlobal, ' ');
  const hasNonSpaceChars = O_nonSpaceChar.test(text);
  const hasSpaceCharsOnBothEnds = O_startingSpaceChar.test(text) && O_endingSpaceChar.test(text);
  if (hasNonSpaceChars && hasSpaceCharsOnBothEnds) {
    text = text.substring(1, text.length - 1);
  }
  out.push(plain ? text : '<code>' + escapeHtml(text, true) + '</code>');
  return i + cap[0].length;
}

function inlineBr(ctx, src, i, plain, out) {
  const cap = I_br.exec(src.slice(i));
  if (!cap) return -1;
  if (!plain) out.push('<br>');
  return i + cap[0].length;
}

function inlineAutolink(ctx, src, i, plain, out) {
  const cap = I_autolink.exec(src.slice(i));
  if (!cap) return -1;
  const text = cap[1];
  if (plain) {
    out.push(text);
    return i + cap[0].length;
  }
  const href = cap[2] === '@' ? 'mailto:' + text : text;
  const parsedText = escapeHtml(text, true);
  const clean = cleanUrl(href);
  if (clean === null) {
    out.push(parsedText);
    return i + cap[0].length;
  }
  out.push('<a href="' + escapeHtml(clean, true) + '">' + parsedText + '</a>');
  return i + cap[0].length;
}

function inlineUrl(ctx, src, i, plain, out) {
  if (ctx.inLink) return -1;
  const cap = I_url.exec(src.slice(i));
  if (!cap) return -1;
  let text;
  let href;
  if (cap[2] === '@') {
    text = cap[0];
    href = 'mailto:' + text;
  } else {
    // Do extended autolink path validation.
    let prevCapZero;
    do {
      prevCapZero = cap[0];
      cap[0] = I__backpedal.exec(cap[0])?.[0] ?? '';
    } while (prevCapZero !== cap[0]);
    text = cap[0];
    href = cap[1] === 'www.' ? 'http://' + cap[0] : cap[0];
  }
  if (plain) {
    out.push(text);
    return i + cap[0].length;
  }
  const parsedText = escapeHtml(text, true);
  const clean = cleanUrl(href);
  if (clean === null) {
    out.push(parsedText);
    return i + cap[0].length;
  }
  out.push('<a href="' + escapeHtml(clean, true) + '">' + parsedText + '</a>');
  return i + cap[0].length;
}

function isLabelEndInsideToken(src, label, labelStart) {
  if (!label.includes('<')) {
    return false;
  }
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') {
      i++;
      continue;
    }
    if (label[i] === '`') {
      const code = I_code.exec(label.slice(i));
      if (code) {
        i += code[0].length - 1;
        continue;
      }
    }
    if (label[i] !== '<') {
      continue;
    }
    const tokenSrc = src.slice(labelStart + i);
    const token = I_tag.exec(tokenSrc) || I_autolink.exec(tokenSrc);
    if (!token) {
      continue;
    }
    if (token[0].length > label.length - i) {
      return true;
    }
    i += token[0].length - 1;
  }
  return false;
}

function outputLink(ctx, cap, href, title, i, plain, out) {
  const text = cap[1].replace(O_outputLinkReplace, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const outerInLink = ctx.inLink;
  const outerLinkEmitted = ctx.linkEmitted;
  const outerInRawBlock = ctx.inRawBlock;
  ctx.inLink = true;
  ctx.linkEmitted = false;
  const inner = renderInline(ctx, text, plain || isImage);
  const textHasLink = ctx.linkEmitted;
  ctx.linkEmitted = outerLinkEmitted;
  ctx.inLink = outerInLink;

  if (!isImage) {
    // CommonMark: "Links may not contain other links, at any level of nesting."
    // Bail so the caller falls through to text and the inner link is the one kept.
    // Images are exempt: their text is flattened into an alt attribute.
    if (textHasLink) {
      // These inner renders are discarded, so undo the raw-block state they
      // opened; leaving it set would suppress escaping for the text that is
      // re-scanned.
      ctx.inRawBlock = outerInRawBlock;
      return -1;
    }
    ctx.linkEmitted = true;
  }

  const len = cap[0].length;
  if (plain) {
    out.push(inner);
    return i + len;
  }
  if (isImage) {
    const clean = cleanUrl(href);
    if (clean === null) {
      out.push(escapeHtml(inner, false));
      return i + len;
    }
    let h = '<img src="' + escapeHtml(clean, false) + '" alt="' + escapeHtml(inner, false) + '"';
    if (title) h += ' title="' + escapeHtml(title, false) + '"';
    h += '>';
    out.push(h);
    return i + len;
  }
  const clean = cleanUrl(href);
  if (clean === null) {
    out.push(inner);
    return i + len;
  }
  let h = '<a href="' + escapeHtml(clean, false) + '"';
  if (title) h += ' title="' + escapeHtml(title, false) + '"';
  h += '>' + inner + '</a>';
  out.push(h);
  return i + len;
}

function inlineLink(ctx, src, i, plain, out) {
  // The link pattern backtracks quadratically over unterminated-link inputs
  // like '[a](b'.repeat(n): at every '[' its greedy unquoted-href run
  // re-partitions the whole remainder while hunting for a ')' that never
  // comes. renderInline anchors one paren scan per run in
  // linkParenPossible; when it is false the pattern cannot match, so bail
  // out before running it.
  if (ctx.linkParenPossible === false) return -1;
  const rem = src.slice(i);
  const cap = I_link.exec(rem);
  if (!cap) return -1;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(rem, cap[1], labelStart)) return -1;

  const trimmedUrl = cap[2].trim();
  if (O_startAngleBracket.test(trimmedUrl)) {
    // CommonMark requires matching angle brackets.
    if (!O_endAngleBracket.test(trimmedUrl)) {
      return -1;
    }
    // The ending angle bracket cannot be escaped.
    const rtrimSlash = rtrim(trimmedUrl.slice(0, -1), '\\');
    if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) {
      return -1;
    }
  } else {
    // Find the closing parenthesis.
    const lastParenIndex = findClosingBracket(cap[2], '()');
    if (lastParenIndex === -2) {
      // More open parens than closed.
      return -1;
    }
    if (lastParenIndex > -1) {
      const start = cap[0].indexOf('!') === 0 ? 5 : 4;
      const linkLen = start + cap[1].length + lastParenIndex;
      cap[2] = cap[2].substring(0, lastParenIndex);
      cap[0] = cap[0].substring(0, linkLen).trim();
      cap[3] = '';
    }
  }
  // The ')' that ends the match is the link closer only when it is not
  // escaped. `[foo](/url\)` has no closer; that paren is destination text.
  const unescaped = rtrim(cap[0].slice(0, -1), '\\');
  if ((cap[0].length - unescaped.length) % 2 === 0) {
    return -1;
  }
  let href = cap[2];
  const title = cap[3] ? cap[3].slice(1, -1) : '';
  href = href.trim();
  if (O_startAngleBracket.test(href)) {
    href = href.slice(1, -1);
  }
  return outputLink(ctx, cap,
    href ? href.replace(I_anyPunctuation, '$1') : href,
    title ? title.replace(I_anyPunctuation, '$1') : title,
    i, plain, out);
}

function inlineReflink(ctx, src, i, plain, out) {
  const rem = src.slice(i);
  const cap = I_reflink.exec(rem) || I_nolink.exec(rem);
  if (!cap) return -1;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(rem, cap[1], labelStart)) return -1;

  const link = ctx.links[normalizeLabel(cap[2] || cap[1])];
  if (!link) {
    // Not a reference: the opening bracket is plain text.
    return -2;
  }
  return outputLink(ctx, cap, link.href, link.title, i, plain, out);
}

function inlineEmStrong(ctx, src, masked, i, prevChar, plain, out) {
  const rem = src.slice(i);
  const match = I_emStrongLDelim.exec(rem);
  if (!match) return -1;
  if (!match[1] && !match[2] && !match[3] && !match[4]) return -1;

  const delimChar = match[0][0];
  // A mid-run opener (for example the second star of an unmatched `**`) must
  // only pair with a delimiter that can only close, otherwise it steals the
  // opener of a later span (`**a*b*c` must be `**a<em>b</em>c`).
  const midRun = prevChar === delimChar;

  // The start of this delimiter run may already be behind `rem`, either taken
  // as text after the whole run failed to match or used to close an earlier
  // span. Flanking and rules 9-10 are about the whole run, so find its start.
  const srcStart = i;
  let runStart = srcStart;
  while (runStart > 0 && masked[runStart - 1] === delimChar) {
    runStart--;
  }
  const runPrevChar = [...masked.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
  // The other delimiter character counts as punctuation here (`_**a*`).
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || !!I_punctuation.exec(runPrevChar);
  if (runStart < srcStart) {
    prevChar = runPrevChar;
  }
  const prevPunct = runStart < srcStart ? runPrevPunct : !!I_punctuation.exec(prevChar);

  // `_` can't be between two alphanumerics. \p{L}\p{N} includes non-english
  // alphabet/numbers as well.
  if (match[4] && prevChar.match(O_unicodeAlphaNumeric)) return -1;

  const nextChar = match[1] || match[3] || '';

  if (!nextChar || !prevChar || prevPunct) {
    // Unicode patterns count emoji as 1 char; spread into an array for a
    // proper count (used multiple times below).
    const lLength = [...match[0]].length - 1;
    let delimTotal = lLength;
    let midDelimTotal = 0;

    // Rules 9-10 count the whole run, and also apply when the opener could
    // close as well (`a*b**`, where `*` is both left- and right-flanking).
    const runLength = srcStart - runStart + lLength;
    const openerCanClose = !!runPrevChar.trim()
      && (!!nextChar || (delimChar === '*' && !runPrevPunct));
    if (delimChar !== '*' && delimChar !== '_') return -1;
    const endReg = delimChar === '*' ? I_emStrongRDelimAst : I_emStrongRDelimUnd;
    const frame = ctx.closerStack.at(-1);
    const lastPossible = delimChar === '*' ? frame.ast : frame.und;
    const windowStart = i + lLength;
    if (lastPossible < windowStart) return -1;
    // Clip the masked source to the same section of the string as `rem`.
    const window = masked.slice(windowStart);
    const lastInWindow = lastPossible - windowStart;
    endReg.lastIndex = 0;

    let m2;
    while ((m2 = endReg.exec(window)) !== null) {
      if (m2.index > lastInWindow) break;
      const rDelim = m2[1] || m2[2] || m2[3] || m2[4] || m2[5] || m2[6];
      if (!rDelim) continue; // skip single * in __abc*abc__

      const rLength0 = [...rDelim].length;

      if (m2[3] || m2[4]) { // found another Left Delim
        delimTotal += rLength0;
        continue;
      } else if (m2[5] || m2[6] || openerCanClose) { // either Left or Right Delim
        if (midRun && (m2[5] || m2[6])) {
          // A mid-run opener cannot close against an ambiguous delimiter that
          // can also open; that delimiter opens its own emphasis span instead.
          break;
        }
        if (runLength % 3 && !((runLength + rLength0) % 3)) {
          midDelimTotal += rLength0;
          continue; // CommonMark Emphasis Rules 9-10
        }
      }

      delimTotal -= rLength0;
      if (delimTotal > 0) continue; // Haven't found enough closing delimiters

      // Remove extra characters. *a*** -> *a*
      const rLength = Math.min(rLength0, rLength0 + delimTotal + midDelimTotal);
      // Char length can be >1 for unicode characters.
      const lastCharLength = [...m2[0]][0].length;
      const raw = rem.slice(0, lLength + m2.index + lastCharLength + rLength);

      // Create `em` if the smallest delimiter has an odd char count. *a***
      if (Math.min(lLength, rLength) % 2) {
        const text = raw.slice(1, -1);
        const inner = renderInline(ctx, text, plain);
        out.push(plain ? inner : '<em>' + inner + '</em>');
        return i + raw.length;
      }

      // Create 'strong' if the smallest delimiter has an even char count. **a***
      const text = raw.slice(2, -2);
      const inner = renderInline(ctx, text, plain);
      out.push(plain ? inner : '<strong>' + inner + '</strong>');
      return i + raw.length;
    }
  }
  return -1;
}

function inlineDel(ctx, src, masked, i, prevChar, plain, out) {
  const rem = src.slice(i);
  const match = I_delLDelim.exec(rem);
  if (!match) return -1;

  const nextChar = match[1] || '';

  if (!nextChar || !prevChar || I_punctuation.exec(prevChar)) {
    // Unicode patterns count emoji as 1 char; spread into an array for a
    // proper count.
    const lLength = [...match[0]].length - 1;
    let delimTotal = lLength;

    const endReg = I_delRDelim;
    const frame = ctx.closerStack.at(-1);
    const windowStart = i + lLength;
    if (frame.del < windowStart) return -1;
    // Clip the masked source to the same section of the string as `rem`.
    const window = masked.slice(windowStart);
    const lastInWindow = frame.del - windowStart;
    endReg.lastIndex = 0;

    let m2;
    while ((m2 = endReg.exec(window)) !== null) {
      if (m2.index > lastInWindow) break;
      const rDelim = m2[1] || m2[2] || m2[3] || m2[4] || m2[5] || m2[6];
      if (!rDelim) continue;

      const rLength0 = [...rDelim].length;
      if (rLength0 !== lLength) continue;

      if (m2[3] || m2[4]) { // found another Left Delim
        delimTotal += rLength0;
        continue;
      }

      delimTotal -= rLength0;
      if (delimTotal > 0) continue; // Haven't found enough closing delimiters

      // Remove extra characters.
      const rLength = Math.min(rLength0, rLength0 + delimTotal);
      // Char length can be >1 for unicode characters.
      const lastCharLength = [...m2[0]][0].length;
      const raw = rem.slice(0, lLength + m2.index + lastCharLength + rLength);

      // Create a del span — only single ~ or double ~~ are supported.
      const text = raw.slice(lLength, -lLength);
      const inner = renderInline(ctx, text, plain);
      out.push(plain ? inner : '<del>' + inner + '</del>');
      return i + raw.length;
    }
  }
  return -1;
}

function scanInline(ctx, src, masked, plain) {
  const out = [];
  const n = src.length;
  let i = 0;
  let prevChar = '';
  while (i < n) {
    const ch = src[i];
    let end = -1;
    if (ch === '\\') {
      end = inlineEscape(ctx, src, i, plain, out);
      if (end < 0) end = inlineBr(ctx, src, i, plain, out);
    } else if (ch === '<') {
      end = inlineTag(ctx, src, i, plain, out);
      if (end < 0) end = inlineAutolink(ctx, src, i, plain, out);
    } else if (ch === '!' || ch === '[') {
      end = inlineLink(ctx, src, i, plain, out);
      if (end < 0) end = inlineReflink(ctx, src, i, plain, out);
    } else if (ch === '*' || ch === '_') {
      end = inlineEmStrong(ctx, src, masked, i, prevChar, plain, out);
      if (end < 0 && ch === '_' && urlMayMatch(src, i)) end = inlineUrl(ctx, src, i, plain, out);
    } else if (ch === '`') {
      end = inlineCodespan(ctx, src, i, plain, out);
      if (end < 0) {
        // A code span that cannot match leaves its opening backticks as
        // text: the reference's text token starts with the whole run of them,
        // so a shorter run inside it must never match a span of its own.
        let j = i + 1;
        while (j < n && src[j] === '`') j++;
        emitText(ctx, src, i, j, plain, out);
        prevChar = '`';
        i = j;
        continue;
      }
    } else if (ch === '~') {
      end = inlineDel(ctx, src, masked, i, prevChar, plain, out);
      if (end < 0) {
        // As with backticks: a strikethrough that cannot match leaves the
        // whole tilde run as text.
        let j = i + 1;
        while (j < n && src[j] === '~') j++;
        emitText(ctx, src, i, j, plain, out);
        prevChar = '~';
        i = j;
        continue;
      }
    } else if (ch === ' ') {
      end = inlineBr(ctx, src, i, plain, out);
      if (end < 0) {
        // A hard break that cannot match leaves only whitespace to the end
        // of the run: the rest is plain text.
        let k = i;
        while (src.charCodeAt(k) === 32) k++;
        if (k - i >= 2 && src.charCodeAt(k) === 10) {
          emitText(ctx, src, i, n, plain, out);
          const last = src[n - 1];
          if (last !== '_') prevChar = last;
          break;
        }
      }
    } else {
      end = urlMayMatch(src, i) ? inlineUrl(ctx, src, i, plain, out) : -1;
    }
    if (end === -2) {
      // One character of plain text (a bracket that is no reference).
      emitText(ctx, src, i, i + 1, plain, out);
      if (src[i] !== '_') prevChar = src[i];
      i++;
      continue;
    }
    if (end > i) {
      // A construct consumed [i, end).
      prevChar = '';
      i = end;
      continue;
    }
    // No construct starts here: emit plain text up to the next candidate.
    let j = nextCandidate(src, i);
    if (j <= i) j = i + 1;
    emitText(ctx, src, i, j, plain, out);
    const last = src[j - 1];
    if (last !== '_') prevChar = last;
    i = j;
  }
  return out.join('');
}

// =====================================================================
// Block parsing: the same block rules as the reference, recognised by a
// first-character dispatch. Inline content is queued while blocks are
// recognised (link references may be defined after their use) and rendered
// once every block is known, exactly as the reference defers it.
// =====================================================================

function queueInline(ctx, text) {
  const q = { src: text, html: '' };
  ctx.queue.push(q);
  return q;
}

function tokSpace(s) {
  const cap = B_newline.exec(s);
  if (cap && cap[0].length > 0) {
    return { t: 'space', raw: cap[0] };
  }
  return undefined;
}

function tokCode(s) {
  const cap = B_code.exec(s);
  if (!cap) return undefined;
  const raw = trimTrailingBlankLines(cap[0]);
  const text = raw.replace(O_codeRemoveIndent, '');
  return { t: 'code', raw, text };
}

function indentCodeCompensation(raw, text) {
  const matchIndentToCode = raw.match(O_indentCodeCompensation);
  if (matchIndentToCode === null) {
    return text;
  }
  const indentToCode = matchIndentToCode[1];
  return text
    .split('\n')
    .map((node) => {
      const matchIndentInNode = node.match(O_beginningSpace);
      if (matchIndentInNode === null) {
        return node;
      }
      const [indentInNode] = matchIndentInNode;
      // Up to the fence's own indentation is removed from each line, so a line
      // indented less than the fence loses whatever indentation it has.
      return node.slice(Math.min(indentInNode.length, indentToCode.length));
    })
    .join('\n');
}

function tokFences(s) {
  const cap = B_fences.exec(s);
  if (!cap) return undefined;
  const raw = cap[0];
  const text = indentCodeCompensation(raw, cap[3] || '');
  return {
    t: 'code',
    raw,
    lang: cap[2] ? cap[2].trim().replace(I_anyPunctuation, '$1') : cap[2],
    text,
  };
}

function tokHeading(ctx, s) {
  const cap = B_heading.exec(s);
  if (!cap) return undefined;
  let text = cap[2].trim();
  // Remove trailing #s.
  if (O_endingHash.test(text)) {
    const trimmed = rtrim(text, '#');
    if (!trimmed || O_endingSpaceTabChar.test(trimmed)) {
      // CommonMark requires a space or tab before trailing #s.
      text = trimmed.trim();
    }
  }
  return {
    t: 'heading',
    raw: rtrim(cap[0], '\n'),
    depth: cap[1].length,
    text,
    q: queueInline(ctx, text),
  };
}

function tokHr(s) {
  const cap = B_hr.exec(s);
  if (!cap) return undefined;
  return { t: 'hr', raw: rtrim(cap[0], '\n') };
}

function tokBlockquote(ctx, s) {
  const cap = B_blockquote.exec(s);
  if (!cap) return undefined;
  let lines = rtrim(cap[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const tokens = [];

  while (lines.length > 0) {
    let inBlockquote = false;
    const currentLines = [];
    let i;
    for (i = 0; i < lines.length; i++) {
      // Get lines up to a continuation.
      if (O_blockquoteStart.test(lines[i])) {
        currentLines.push(lines[i]);
        inBlockquote = true;
      } else if (!inBlockquote) {
        currentLines.push(lines[i]);
      } else {
        break;
      }
    }
    lines = lines.slice(i);

    const currentRaw = currentLines.join('\n');
    const currentText = currentRaw
      // A tab after the block quote marker runs to the next tab stop, and
      // the marker only consumes one space of it; the rest is content.
      .replace(
        O_blockquoteMarkerWhitespace,
        (_, marker, whitespace) => marker + expandTabs(whitespace, marker.length),
      )
      // Precede setext continuation with 4 spaces so it isn't a setext.
      .replace(O_blockquoteSetextReplace, '\n    $1')
      .replace(O_blockquoteSetextReplace2, '');
    raw = raw ? raw + '\n' + currentRaw : currentRaw;
    text = text ? text + '\n' + currentText : currentText;

    // Parse blockquote lines as top level tokens; merge paragraphs if this
    // is a continuation.
    const top = ctx.top;
    ctx.top = true;
    blockTokens(ctx, currentText, tokens, true);
    ctx.top = top;

    // If there is no continuation then we are done.
    if (lines.length === 0) {
      break;
    }

    const lastToken = tokens.at(-1);

    if (lastToken?.t === 'code' || lastToken?.t === 'heading' || lastToken?.t === 'hr' || lastToken?.t === 'html' || lastToken?.t === 'table') {
      // Blockquote continuation cannot be preceded by a code block, heading,
      // hr, html block or table.
      break;
    } else if (lastToken?.t === 'blockquote') {
      // Include continuation in nested blockquote.
      const oldToken = lastToken;
      // The continuation lines belong to the same nesting frame as the
      // nested blockquote, which already had one '>' marker stripped, so
      // strip one marker from them too. Otherwise a restated marker after a
      // lazy line is re-parsed as a spurious deeper blockquote.
      const continuation = lines.join('\n');
      const newText = oldToken.raw + '\n' + continuation.replace(O_blockquoteSetextReplace2, '');
      const newToken = tokBlockquote(ctx, newText);
      tokens[tokens.length - 1] = newToken;

      // Only include continuation lines the nested blockquote actually
      // consumed. Unconsumed trailing lines must stay out of `raw` so the
      // lexer can still tokenize them (paragraph, next blockquote, etc.).
      const leftover = newText.substring(newToken.raw.length).replace(/^\n/, '');
      const leftoverCount = leftover ? leftover.split('\n').length : 0;
      const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
      if (consumed.length > 0) {
        raw = raw + '\n' + consumed.join('\n');
      }
      text = text.substring(0, text.length - oldToken.text.length) + newToken.text;

      // A leftover line that starts with '>' still belongs to this
      // blockquote; any other leftover line ends it.
      lines = lines.slice(consumed.length);
      if (lines.length > 0 && O_blockquoteStart.test(lines[0])) {
        continue;
      }
      break;
    } else if (lastToken?.t === 'list') {
      // Include continuation in nested list.
      const oldToken = lastToken;
      const newText = oldToken.raw + '\n' + lines.join('\n');
      const newToken = tokList(ctx, newText);
      tokens[tokens.length - 1] = newToken;

      // The list raw has no '>' markers, so it cannot be cut out of `raw`.
      // Count the continuation lines the list took and add those lines instead.
      const consumedCount = newToken.raw.length > oldToken.raw.length
        ? newText.slice(oldToken.raw.length + 1, newToken.raw.length).split('\n').length
        : 0;
      if (consumedCount > 0) {
        const consumed = lines.slice(0, consumedCount).join('\n');
        raw = raw + '\n' + consumed;
        text = text + '\n' + consumed;
      }
      lines = lines.slice(consumedCount);
      continue;
    }
  }

  return { t: 'blockquote', raw, tokens, text };
}

function tokList(ctx, s) {
  const cap0 = B_list.exec(s);
  if (!cap0) return undefined;
  // `rest` is only consumed from the front, so every raw below is a slice of
  // listSrc rather than a string built up line by line.
  const listSrc = s;
  let rest = s;
  const taken = () => listSrc.length - rest.length;
  let bull = cap0[1].trim();
  const isordered = bull.length > 1;

  const list = {
    t: 'list',
    raw: '',
    ordered: isordered,
    start: isordered ? +bull.slice(0, -1) : '',
    loose: false,
    items: [],
  };

  bull = isordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;

  // Get next list item.
  const itemRegex = listItemRegex(bull);
  let endsWithBlankLine = false;
  // Check if current bullet point can start a new list item.
  while (rest) {
    let endEarly = false;
    let itemContents = '';
    let cap;
    if (!(cap = itemRegex.exec(rest))) {
      break;
    }

    if (B_hr.test(rest)) { // End list if bullet was actually HR.
      break;
    }

    const itemStart = taken();
    rest = rest.substring(cap[0].length);

    const firstLine = cap[2].split('\n', 1)[0];
    const bulletIndent = cap[1].length;
    const line = firstLine.replace(O_leadingSpaceTab, (whitespace) => expandTabs(whitespace, bulletIndent));
    let nextLine = rest.split('\n', 1)[0];
    let blankLine = !line.trim();

    let indent = 0;
    if (blankLine) {
      indent = bulletIndent + 1;
    } else {
      indent = line.search(O_nonSpaceChar); // Find first non-space char.
      indent = indent > 4 ? 1 : indent; // Treat indented code blocks (> 4 spaces) as having only 1 indent.
      itemContents = line.slice(indent);
      indent += bulletIndent;
    }

    if (blankLine && O_blankLine.test(nextLine)) { // Items begin with at most one blank line.
      rest = rest.substring(nextLine.length + 1);
      endEarly = true;
    }

    if (!endEarly) {
      const nextBullet = nextBulletRegex(indent);
      const hrRe = hrRegex(indent);
      const fencesBegin = fencesBeginRegex(indent);
      const headingBegin = headingBeginRegex(indent);
      const htmlBegin = htmlBeginRegex(indent);
      const blockquoteBegin = blockquoteBeginRegex(indent);

      // Check if following lines should be included in the list item.
      let curLine = line;
      while (rest) {
        const rawLine = rest.split('\n', 1)[0];
        nextLine = rawLine;

        // Re-align to follow CommonMark nesting rules.
        const nextLineWithoutTabs = nextLine.replace(O_leadingSpaceTab, (whitespace) => expandTabs(whitespace));

        // End list item if found code fences.
        if (fencesBegin.test(nextLine)) {
          break;
        }
        // End list item if found start of new heading.
        if (headingBegin.test(nextLine)) {
          break;
        }
        // End list item if found start of html block.
        if (htmlBegin.test(nextLine)) {
          break;
        }
        // End list item if found start of blockquote.
        if (blockquoteBegin.test(nextLine)) {
          break;
        }
        // End list item if found start of new bullet.
        if (nextBullet.test(nextLine)) {
          break;
        }
        // Horizontal rule found.
        if (hrRe.test(nextLine)) {
          break;
        }

        if (nextLineWithoutTabs.search(O_nonSpaceChar) >= indent || !nextLine.trim()) { // Dedent if possible.
          itemContents += '\n' + nextLineWithoutTabs.slice(indent);
        } else {
          // Not enough indentation.
          if (blankLine) {
            break;
          }
          // Paragraph continuation unless last line was a different block level element.
          if (curLine.replace(O_tabCharGlobal, '    ').search(O_nonSpaceChar) >= 4) { // Indented code block.
            break;
          }
          if (fencesBegin.test(curLine)) {
            break;
          }
          if (headingBegin.test(curLine)) {
            break;
          }
          if (htmlBegin.test(curLine)) {
            break;
          }
          if (hrRe.test(curLine)) {
            break;
          }
          // A lazy continuation can look like a setext underline after
          // list indentation is removed. Keep it in the paragraph.
          const setextContinuation = /^ {0,3}(?:=+|-+) *$/.test(nextLine)
            && B_lheading.test(curLine + '\n' + nextLine);
          const continuation = setextContinuation
            ? '    ' + nextLineWithoutTabs.replace(/^ {0,3}/, '')
            : nextLine;
          itemContents += '\n' + continuation;
        }

        blankLine = !nextLine.trim();
        rest = rest.substring(rawLine.length + 1);
        curLine = nextLineWithoutTabs.slice(indent);
      }
    }

    // The loops above appended a '\n' the source may not have had. It could
    // only land on the item that exhausts `rest`, whose raw is trimmed below,
    // and after which nothing reads endsWithBlankLine.
    const raw = listSrc.slice(itemStart, taken());

    if (!list.loose) {
      // If the previous item ended with a blank line, the list is loose.
      if (endsWithBlankLine) {
        list.loose = true;
      } else if (endsWithDoubleBlankLine(raw)) {
        endsWithBlankLine = true;
      }
    }

    list.items.push({
      t: 'list_item',
      raw,
      task: !!O_listIsTask.test(itemContents),
      loose: false,
      text: itemContents,
      tokens: [],
    });
  }

  // Do not consume newlines at end of final item.
  const lastItem = list.items.at(-1);
  if (lastItem) {
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
  } else {
    // Not a list since there were no items.
    return undefined;
  }
  list.raw = listSrc.slice(0, taken()).trimEnd();

  // Item child tokens handled here at end because we needed to have the final
  // item to trim it first. First pass: tokenize items and finalize
  // list.loose from spacers before placing checkboxes.
  for (const item of list.items) {
    ctx.top = false;
    item.tokens = blockTokens(ctx, item.text, []);

    if (!list.loose) {
      // Check if list should be loose.
      const spacers = item.tokens.filter((t) => t.t === 'space');
      const hasMultipleLineBreaks = spacers.length > 0 && spacers.some((t) => O_anyLine.test(t.raw));
      list.loose = hasMultipleLineBreaks;
    }
  }

  // Second pass: place task checkboxes using the final list.loose.
  for (const item of list.items) {
    const itemToken = item.tokens[0];
    if (item.task && (itemToken?.t === 'text' || itemToken?.t === 'paragraph')) {
      // Remove checkbox markdown from item tokens.
      item.text = item.text.replace(O_listReplaceTask, '');
      itemToken.raw = itemToken.raw.replace(O_listReplaceTask, '');
      itemToken.text = itemToken.text.replace(O_listReplaceTask, '');
      for (let i = ctx.queue.length - 1; i >= 0; i--) {
        if (O_listIsTask.test(ctx.queue[i].src)) {
          ctx.queue[i].src = ctx.queue[i].src.replace(O_listReplaceTask, '');
          break;
        }
      }

      const taskRaw = O_listTaskCheckbox.exec(item.raw);
      if (taskRaw) {
        const checkboxToken = {
          t: 'checkbox',
          raw: taskRaw[0] + ' ',
          checked: taskRaw[0] !== '[ ]',
        };
        item.checked = checkboxToken.checked;
        if (list.loose) {
          if (item.tokens[0] && (item.tokens[0].t === 'paragraph' || item.tokens[0].t === 'text')) {
            item.tokens[0].raw = checkboxToken.raw + item.tokens[0].raw;
            item.tokens[0].text = checkboxToken.raw + item.tokens[0].text;
            // The checkbox renders before the item's inline content.
            item.tokens[0].prefix = checkboxToken;
          } else {
            item.tokens.unshift({
              t: 'paragraph',
              raw: checkboxToken.raw,
              text: checkboxToken.raw,
              q: { src: '', html: '' },
              prefix: checkboxToken,
            });
          }
        } else {
          item.tokens.unshift(checkboxToken);
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }

  // Set all items to loose if list is loose.
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const token of item.tokens) {
        if (token.t === 'text') {
          token.t = 'paragraph';
        }
      }
    }
  }

  return list;
}

function tokHtml(s) {
  const cap = B_html.exec(s);
  if (!cap) return undefined;
  const raw = trimTrailingBlankLines(cap[0]);
  return {
    t: 'html',
    raw,
    pre: cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style',
    text: raw,
  };
}

function tokDef(s) {
  const cap = B_def.exec(s);
  if (!cap) return undefined;
  // Outside angle brackets a link destination holds only balanced parentheses.
  if (!O_startAngleBracket.test(cap[2]) && findClosingBracket(cap[2], '()') !== -1) {
    return undefined;
  }
  const tag = normalizeLabel(cap[1]);
  const href = cap[2] ? cap[2].replace(O_hrefBrackets, '$1').replace(I_anyPunctuation, '$1') : '';
  const title = cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(I_anyPunctuation, '$1') : cap[3];
  return {
    t: 'def',
    tag,
    raw: rtrim(cap[0], '\n'),
    href,
    title,
  };
}

function tokTable(ctx, s) {
  const cap = B_table.exec(s);
  if (!cap) return undefined;
  if (!O_tableDelimiter.test(cap[2])) {
    // Delimiter row must have a pipe (|) or colon (:), otherwise it is a
    // setext heading.
    return undefined;
  }
  const headers = splitCells(cap[1]);
  const aligns = cap[2].replace(O_tableAlignChars, '').split('|');
  const rows = cap[3] && cap[3].trim() ? cap[3].replace(O_tableRowBlankLine, '').split('\n') : [];

  const item = {
    t: 'table',
    raw: rtrim(cap[0], '\n'),
    header: [],
    align: [],
    rows: [],
  };

  if (headers.length !== aligns.length) {
    // Header and align columns must be equal; rows can be different.
    return undefined;
  }

  for (const align of aligns) {
    if (O_tableAlignRight.test(align)) {
      item.align.push('right');
    } else if (O_tableAlignCenter.test(align)) {
      item.align.push('center');
    } else if (O_tableAlignLeft.test(align)) {
      item.align.push('left');
    } else {
      item.align.push(null);
    }
  }

  for (let i = 0; i < headers.length; i++) {
    item.header.push({
      text: headers[i],
      q: queueInline(ctx, headers[i]),
      header: true,
      align: item.align[i],
    });
  }

  for (const row of rows) {
    item.rows.push(splitCells(row, item.header.length).map((cell, i) => ({
      text: cell,
      q: queueInline(ctx, cell),
      header: false,
      align: item.align[i],
    })));
  }

  return item;
}

function tokLheading(ctx, s) {
  const cap = B_lheading.exec(s);
  if (!cap) return undefined;
  const text = cap[1].trim();
  return {
    t: 'heading',
    raw: rtrim(cap[0], '\n'),
    depth: cap[2].charAt(0) === '=' ? 1 : 2,
    text,
    q: queueInline(ctx, text),
  };
}

function tokParagraph(ctx, s) {
  const cap = B_paragraph.exec(s);
  if (!cap) return undefined;
  const text = cap[1].charAt(cap[1].length - 1) === '\n'
    ? cap[1].slice(0, -1)
    : cap[1];
  return {
    t: 'paragraph',
    raw: cap[0],
    text,
    q: queueInline(ctx, text),
  };
}

function tokText(ctx, s) {
  const cap = B_text.exec(s);
  if (!cap) return undefined;
  return {
    t: 'text',
    raw: cap[0],
    text: cap[0],
    q: queueInline(ctx, cap[0]),
  };
}

// The table's delimiter row is the second line: it must hold a `-` and a
// `|` or `:` for the table pattern to match at all.
function tablePrecheck(s) {
  const nl = s.indexOf('\n');
  if (nl === -1) return false;
  const nl2 = s.indexOf('\n', nl + 1);
  const line2 = nl2 === -1 ? s.slice(nl + 1) : s.slice(nl + 1, nl2);
  return line2.includes('-') && (line2.includes('|') || line2.includes(':'));
}

function blockTokens(ctx, s, tokens, lastParagraphClipped) {
  let srcLen = Infinity;
  while (s) {
    if (s.length < srcLen) {
      srcLen = s.length;
    } else {
      throw new Error('Infinite loop on byte: ' + s.charCodeAt(0));
    }

    let token;
    const c0 = s.charCodeAt(0);

    // Newline (blank lines).
    if (c0 === 10 || c0 === 32 || c0 === 9) {
      token = tokSpace(s);
      if (token) {
        s = s.substring(token.raw.length);
        const lastToken = tokens.at(-1);
        if (token.raw.length === 1 && lastToken !== undefined) {
          // If there's a single \n as a spacer, it's terminating the last
          // line, so move it there so that we don't get unnecessary
          // paragraph tags.
          lastToken.raw += '\n';
        } else {
          tokens.push(token);
        }
        continue;
      }
    }

    // Indented code.
    if (startsIndentedCode(s)) {
      token = tokCode(s);
      if (token) {
        s = s.substring(token.raw.length);
        const lastToken = tokens.at(-1);
        // An indented code block cannot interrupt a paragraph.
        if (lastToken && (lastToken.t === 'paragraph' || lastToken.t === 'text')) {
          lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
          lastToken.text += '\n' + token.text;
          ctx.queue.at(-1).src = lastToken.text;
        } else {
          tokens.push(token);
        }
        continue;
      }
    }

    // First non-space character (up to three spaces of indent): only the
    // rules that can start with it are tried.
    let j = 0;
    while (j < 3 && s.charCodeAt(j) === 32) j++;
    const d = s[j];

    // Fences.
    if (d === '`' || d === '~') {
      token = tokFences(s);
      if (token) {
        s = s.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    }

    // Heading.
    if (d === '#') {
      token = tokHeading(ctx, s);
      if (token) {
        s = s.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    }

    // Thematic break.
    if (d === '-' || d === '+' || d === '*' || d === '_') {
      token = tokHr(s);
      if (token) {
        s = s.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    }

    // Blockquote.
    if (d === '>') {
      token = tokBlockquote(ctx, s);
      if (token) {
        s = s.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    }

    // List.
    if (d === '-' || d === '+' || d === '*' || (d >= '0' && d <= '9')) {
      token = tokList(ctx, s);
      if (token) {
        s = s.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    }

    // HTML block.
    if (d === '<') {
      token = tokHtml(s);
      if (token) {
        s = s.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    }

    // Link reference definition.
    if (d === '[') {
      token = tokDef(s);
      if (token) {
        s = s.substring(token.raw.length);
        const lastToken = tokens.at(-1);
        if (lastToken && (lastToken.t === 'paragraph' || lastToken.t === 'text')) {
          lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
          lastToken.text += '\n' + token.raw;
          ctx.queue.at(-1).src = lastToken.text;
        } else {
          // The first definition of a label wins, but a later one still
          // consumes its text.
          if (!ctx.links[token.tag]) {
            ctx.links[token.tag] = { href: token.href, title: token.title };
          }
          tokens.push(token);
        }
        continue;
      }
    }

    // Table (GFM).
    if (tablePrecheck(s)) {
      token = tokTable(ctx, s);
      if (token) {
        s = s.substring(token.raw.length);
        tokens.push(token);
        continue;
      }
    }

    // Setext heading. A setext underline is a line starting with 0–3 spaces
    // then `=` or `-`; without one the rule cannot match, so skip its regex.
    token = hasSetextUnderline(s) ? tokLheading(ctx, s) : undefined;
    if (token) {
      s = s.substring(token.raw.length);
      tokens.push(token);
      continue;
    }

    // Top-level paragraph.
    if (ctx.top) {
      token = tokParagraph(ctx, s);
      if (token) {
        const lastToken = tokens.at(-1);
        if (lastParagraphClipped && lastToken && lastToken.t === 'paragraph') {
          lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
          lastToken.text += '\n' + token.text;
          ctx.queue.pop();
          ctx.queue.at(-1).src = lastToken.text;
        } else {
          tokens.push(token);
        }
        lastParagraphClipped = false;
        s = s.substring(token.raw.length);
        continue;
      }
    }

    // Text.
    token = tokText(ctx, s);
    if (token) {
      s = s.substring(token.raw.length);
      const lastToken = tokens.at(-1);
      if (lastToken && lastToken.t === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
        ctx.queue.pop();
        ctx.queue.at(-1).src = lastToken.text;
      } else {
        tokens.push(token);
      }
      continue;
    }

    throw new Error('Infinite loop on byte: ' + s.charCodeAt(0));
  }

  ctx.top = true;
  return tokens;
}

// =====================================================================
// Rendering the block tree to HTML.
// =====================================================================

function renderCode(tok) {
  const langString = (tok.lang || '').match(O_notSpaceStart)?.[0];
  // An empty code block has no content, so it must not gain a newline.
  const code = tok.text ? tok.text.replace(O_endingNewline, '') + '\n' : '';
  if (!langString) {
    return '<pre><code>' + escapeHtml(code, true) + '</code></pre>\n';
  }
  return '<pre><code class="language-'
    + escapeHtml(langString, false)
    + '">'
    + escapeHtml(code, true)
    + '</code></pre>\n';
}

function renderCell(c) {
  const type = c.header ? 'th' : 'td';
  const tag = c.align ? '<' + type + ' align="' + c.align + '">' : '<' + type + '>';
  return tag + c.q.html + '</' + type + '>\n';
}

function renderTable(tok) {
  let header = '';
  let cell = '';
  for (let k = 0; k < tok.header.length; k++) {
    cell += renderCell(tok.header[k]);
  }
  header += '<tr>\n' + cell + '</tr>\n';

  let body = '';
  for (let k = 0; k < tok.rows.length; k++) {
    const row = tok.rows[k];
    cell = '';
    for (let m = 0; m < row.length; m++) {
      cell += renderCell(row[m]);
    }
    body += '<tr>\n' + cell + '</tr>\n';
  }
  if (body) body = '<tbody>' + body + '</tbody>';

  return '<table>\n'
    + '<thead>\n'
    + header
    + '</thead>\n'
    + body
    + '</table>\n';
}

function renderList(tok) {
  let body = '';
  for (let k = 0; k < tok.items.length; k++) {
    body += '<li>' + renderBlocks(tok.items[k].tokens) + '</li>\n';
  }
  const type = tok.ordered ? 'ol' : 'ul';
  const startAttr = (tok.ordered && tok.start !== 1) ? ' start="' + tok.start + '"' : '';
  return '<' + type + startAttr + '>\n' + body + '</' + type + '>\n';
}

function renderBlock(tok) {
  switch (tok.t) {
    case 'space': return '';
    case 'hr': return '<hr>\n';
    case 'heading': return '<h' + tok.depth + '>' + tok.q.html + '</h' + tok.depth + '>\n';
    case 'code': return renderCode(tok);
    case 'table': return renderTable(tok);
    case 'blockquote': return '<blockquote>\n' + renderBlocks(tok.tokens) + '</blockquote>\n';
    case 'list': return renderList(tok);
    case 'checkbox': return '<input ' + (tok.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
    case 'html': return tok.text;
    case 'def': return '';
    case 'paragraph': return '<p>' + (tok.prefix ? renderBlock(tok.prefix) : '') + tok.q.html + '</p>\n';
    case 'text': return (tok.prefix ? renderBlock(tok.prefix) : '') + tok.q.html;
    default: return '';
  }
}

function renderBlocks(tokens) {
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    out += renderBlock(tokens[i]);
  }
  return out;
}

// =====================================================================
// Entry point: render one Markdown string to HTML.
// =====================================================================

/**
 * The HTML marked 18.1.3 renders for `markdown`, with marked's defaults.
 * Fresh state on every call; nothing is kept from an earlier call.
 */
export function parse(markdown) {
  if (typeof markdown !== 'string') {
    throw new Error('marked(): input parameter is of type '
      + Object.prototype.toString.call(markdown) + ', string expected');
  }
  const ctx = newCtx();
  const src = markdown.replace(O_carriageReturn, '\n');
  const tokens = blockTokens(ctx, src, [], false);

  for (let i = 0; i < ctx.queue.length; i++) {
    const q = ctx.queue[i];
    // An inline <pre>, <code>, <kbd> or <script> left open ends with the
    // block holding it; carried over, it would stop every later block's text
    // from being escaped.
    ctx.inRawBlock = false;
    q.html = renderInline(ctx, q.src, false);
  }

  return renderBlocks(tokens);
}

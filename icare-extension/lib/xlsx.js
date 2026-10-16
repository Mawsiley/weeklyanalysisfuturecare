/**
 * كاتب ملفات Excel (.xlsx) مصغّر بدون مكتبات خارجية.
 * buildXlsx({ sheetName, headers, rows, rtl }) → Blob
 * الملف ZIP بدون ضغط (stored) يحتوي أقل مجموعة XML يقبلها Excel وGoogle Sheets.
 */
(function () {
  const enc = new TextEncoder();

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  // ZIP بدون ضغط
  function zip(files) {
    const chunks = [];
    const central = [];
    let offset = 0;
    const u16 = v => [v & 0xFF, (v >>> 8) & 0xFF];
    const u32 = v => [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF];

    files.forEach(({ name, content }) => {
      const nameBytes = enc.encode(name);
      const data = enc.encode(content);
      const crc = crc32(data);
      const common = [
        ...u16(20), ...u16(0x0800), ...u16(0), // version, flags (UTF-8), method: stored
        ...u16(0), ...u16(0x21),               // time, date (1980-01-01)
        ...u32(crc), ...u32(data.length), ...u32(data.length),
        ...u16(nameBytes.length)
      ];
      const local = new Uint8Array([...u32(0x04034B50), ...common, ...u16(0)]);
      chunks.push(local, nameBytes, data);
      central.push(new Uint8Array([
        ...u32(0x02014B50), ...u16(20), ...common,
        ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset)
      ]), nameBytes);
      offset += local.length + nameBytes.length + data.length;
    });

    const centralSize = central.reduce((n, c) => n + c.length, 0);
    const end = new Uint8Array([
      ...u32(0x06054B50), ...u16(0), ...u16(0),
      ...u16(files.length), ...u16(files.length),
      ...u32(centralSize), ...u32(offset), ...u16(0)
    ]);
    return new Blob([...chunks, ...central, end],
      { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  function xmlEscape(value) {
    return String(value ?? '')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function colName(index) {
    let name = '';
    for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
      name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
    }
    return name;
  }

  // الأرقام الخالصة (مثل رقم الملف) تُكتب كأرقام حتى يسهل الفرز والبحث في Excel
  function cell(ref, value, style) {
    const s = style ? ' s="' + style + '"' : '';
    if (typeof value === 'number' || (/^\d{1,15}$/.test(String(value)) && !/^0\d/.test(String(value)))) {
      return '<c r="' + ref + '"' + s + '><v>' + Number(value) + '</v></c>';
    }
    return '<c r="' + ref + '"' + s + ' t="inlineStr"><is><t xml:space="preserve">' + xmlEscape(value) + '</t></is></c>';
  }

  function buildXlsx({ sheetName = 'Sheet1', headers = [], rows = [], rtl = true, widths = [] }) {
    const all = [headers, ...rows];
    const sheetRows = all.map((row, r) =>
      '<row r="' + (r + 1) + '">' +
      row.map((value, c) => cell(colName(c) + (r + 1), value, r === 0 ? 1 : 0)).join('') +
      '</row>').join('');
    const cols = headers.map((h, i) => {
      const longest = Math.max(...all.map(row => String(row[i] ?? '').length), 6);
      const width = widths[i] || Math.min(60, longest + 4);
      return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + width + '" customWidth="1"/>';
    }).join('');
    const lastRef = colName(Math.max(headers.length - 1, 0)) + Math.max(all.length, 1);
    const safeSheet = xmlEscape(String(sheetName).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Sheet1');

    const files = [
      { name: '[Content_Types].xml', content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '</Types>' },
      { name: '_rels/.rels', content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
        '</Relationships>' },
      { name: 'xl/workbook.xml', content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<sheets><sheet name="' + safeSheet + '" sheetId="1" r:id="rId1"/></sheets></workbook>' },
      { name: 'xl/_rels/workbook.xml.rels', content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '</Relationships>' },
      { name: 'xl/styles.xml', content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>' +
        '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
        '<fill><patternFill patternType="solid"><fgColor rgb="FF1E4E4D"/><bgColor indexed="64"/></patternFill></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
        '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
        '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>' +
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
        '</styleSheet>' },
      { name: 'xl/worksheets/sheet1.xml', content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<dimension ref="A1:' + lastRef + '"/>' +
        '<sheetViews><sheetView workbookViewId="0"' + (rtl ? ' rightToLeft="1"' : '') + '>' +
        '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
        (cols ? '<cols>' + cols + '</cols>' : '') +
        '<sheetData>' + sheetRows + '</sheetData>' +
        (headers.length ? '<autoFilter ref="A1:' + lastRef + '"/>' : '') +
        '</worksheet>' }
    ];
    return zip(files);
  }

  window.buildXlsx = buildXlsx;
})();

// HTML forms as a browser submits them, for the probes that post to PHP.
'use strict';

function decodeEntities(text) {
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function attribute(tag, name) {
  const match = tag.match(new RegExp(`\\s${name}="([^"]*)"`, 'i'));
  return match ? decodeEntities(match[1]) : null;
}

// The form named formName in html, or its first form when formName is null:
// its action, and the [name, value] pairs a browser sends when no button is
// clicked and nothing is changed, in document order. Image and submit
// buttons, file inputs, and unchecked checkboxes and radio buttons send
// nothing.
function readForm(html, formName = null) {
  const start = html.search(formName === null ? /<form\b/i : new RegExp(`<form[^>]*\\sname="${formName}"`, 'i'));
  if (start < 0) {
    throw new Error(formName === null ? 'no form' : `no form named ${formName}`);
  }
  const end = html.indexOf('</form>', start);
  const form = html.slice(start, end < 0 ? html.length : end);
  const fields = [];
  const controls = /<input\b[^>]*>|<select\b[^>]*>[\s\S]*?<\/select>|<textarea\b[^>]*>[\s\S]*?<\/textarea>/gi;
  for (const [control] of form.matchAll(controls)) {
    const tag = control.match(/^<[^>]*>/)[0];
    const name = attribute(tag, 'name');
    if (name === null) {
      continue;
    }
    if (/^<input/i.test(tag)) {
      const type = (attribute(tag, 'type') || 'text').toLowerCase();
      if (['image', 'submit', 'button', 'reset', 'file'].includes(type)) {
        continue;
      }
      if (['checkbox', 'radio'].includes(type) && !/\schecked\b/i.test(tag)) {
        continue;
      }
      fields.push([name, attribute(tag, 'value') ?? (type === 'checkbox' ? 'on' : '')]);
    } else if (/^<select/i.test(tag)) {
      const options = [...control.matchAll(/<option\b[^>]*>/gi)].map(([option]) => ({
        value: attribute(option, 'value') ?? '',
        selected: /\sselected\b/i.test(option),
      }));
      const selected = options.filter(option => option.selected);
      if (/\smultiple\b/i.test(tag)) {
        selected.forEach(option => fields.push([name, option.value]));
      } else if (options.length > 0) {
        fields.push([name, (selected[0] || options[0]).value]);
      }
    } else {
      fields.push([name, decodeEntities(control.replace(/^<[^>]*>/, '').replace(/<\/textarea>$/i, '').replace(/^\r?\n/, ''))]);
    }
  }
  return { action: attribute(form.match(/^<form[^>]*>/i)[0], 'action'), fields };
}

// A multipart/form-data body. parts: { name, value } or, for a file,
// { name, filename, value }. Values are ISO-8859-1 strings.
function multipart(boundary, parts) {
  const chunks = [];
  for (const part of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"`;
    if (part.filename) {
      head += `; filename="${part.filename}"\r\nContent-Type: application/octet-stream`;
    }
    chunks.push(`${head}\r\n\r\n${part.value}\r\n`);
  }
  chunks.push(`--${boundary}--\r\n`);
  return chunks.join('');
}

module.exports = { readForm, multipart };

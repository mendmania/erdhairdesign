export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// Inline styles and presentation tables keep the design usable in email clients.
export function emailLayout({ language = 'sq', title, intro, details = [], action, code, footer }) {
  const e = escapeHtml;
  const actionMarkup = action ? `<table role="presentation" ${action.prominent ? 'width="100%"' : ''} cellspacing="0" cellpadding="0" style="margin-top:28px;"><tr><td bgcolor="#253b32" align="center" style="border-radius:6px;mso-padding-alt:20px 16px;"><a href="${e(action.url)}" style="display:${action.prominent ? 'block' : 'inline-block'};padding:${action.prominent ? '20px 16px' : '16px 24px'};font-family:Arial,sans-serif;font-size:${action.prominent ? '18px' : '14px'};line-height:1.4;font-weight:bold;text-align:center;text-decoration:none;color:#fffdf8;">${e(action.label)} &rarr;</a></td></tr></table>${action.hint ? `<p style="margin:14px 0 0;font-family:Arial,sans-serif;font-size:13px;line-height:1.6;color:#5c625b;">${e(action.hint)}</p>` : ''}<p style="margin:20px 0 0;font-family:Arial,sans-serif;font-size:12px;line-height:1.6;color:#727266;overflow-wrap:anywhere;">${e(language === 'sq' ? 'Ose hapni këtë lidhje:' : 'Or open this link:')} <a href="${e(action.url)}" style="color:#253b32;word-break:break-all;">${e(action.url)}</a></p>` : '';

  return `<!doctype html><html lang="${language === 'sq' ? 'sq' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${e(title)}</title></head>
<body style="margin:0;padding:0;background:#eeede8;color:#252b27;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${e(intro)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#eeede8;"><tr><td align="center" style="padding:32px 12px;">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#fffdf8;border:1px solid #ded9cc;">
<tr><td align="center" style="padding:34px 24px;background:#253b32;border-bottom:3px solid #bca574;"><div style="font-family:Georgia,'Times New Roman',serif;font-size:42px;letter-spacing:6px;color:#fffdf8;">ERD</div><div style="padding-top:8px;font-family:Arial,sans-serif;font-size:11px;letter-spacing:4px;color:#e1d3b4;">HAIR DESIGN</div></td></tr>
<tr><td style="padding:36px 24px;"><h1 style="margin:0 0 18px;font-family:Georgia,'Times New Roman',serif;font-size:32px;line-height:1.2;font-weight:400;">${e(title)}</h1><p style="margin:0 0 28px;font-family:Arial,sans-serif;font-size:16px;line-height:1.7;color:#5c625b;">${e(intro)}</p>
${code ? `<div style="padding:24px 12px;background:#f1ede3;border:1px solid #ded9cc;text-align:center;font-family:Arial,sans-serif;font-size:32px;letter-spacing:8px;font-weight:bold;color:#253b32;">${e(code)}</div>` : ''}
${action?.prominent ? `<div style="margin-bottom:28px;">${actionMarkup}</div>` : ''}
${details.length ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-top:1px solid #ded9cc;">${details.map(([label,value]) => `<tr><td style="padding:16px 4px;border-bottom:1px solid #ded9cc;font-family:Arial,sans-serif;"><div style="font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#727266;margin-bottom:7px;">${e(label)}</div><div style="font-size:17px;line-height:1.5;color:#253b32;overflow-wrap:anywhere;">${e(value)}</div></td></tr>`).join('')}</table>` : ''}
${action && !action.prominent ? actionMarkup : ''}
</td></tr><tr><td style="padding:24px;border-top:1px solid #ded9cc;background:#f6f3ec;"><p style="margin:0;font-family:Arial,sans-serif;font-size:12px;line-height:1.7;color:#65695f;">${e(footer)}</p><p style="margin:16px 0 0;font-family:Georgia,'Times New Roman',serif;font-size:16px;color:#253b32;">ERD Hair Design</p></td></tr>
</table></td></tr></table></body></html>`;
}

export function verificationEmail(code, language = 'sq') {
  const sq = language === 'sq';
  const subject = sq ? 'Kodi juaj i verifikimit ERD' : 'Your ERD verification code';
  const intro = sq ? 'Një hap më afër terminit tuaj. Përdorni kodin më poshtë për të verifikuar emailin.' : 'One step closer to your next visit. Use the code below to verify your email.';
  const footer = sq ? 'Kodi skadon pas 10 minutash. Nëse nuk e keni kërkuar, mund ta shpërfillni këtë email.' : 'This code expires in 10 minutes. If you did not request this, you can ignore this email.';
  return { subject, textContent: sq ? `Kodi juaj i verifikimit për ERD Hair Design është ${code}. ${footer}` : `Your ERD Hair Design verification code is ${code}. ${footer}`,
    htmlContent: emailLayout({language, title: sq ? 'Mirë se vini në ERD.' : 'Welcome to ERD.', intro, code, footer}) };
}

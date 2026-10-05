'use strict';
const JSZip = require('jszip');
const NS = 'http://schemas.openxmlformats.org';
const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const rel = (id, type, target) => `<Relationship Id="${id}" Type="${NS}/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
const relationships = contents => `${head}<Relationships xmlns="${NS}/package/2006/relationships">${contents}</Relationships>`;
const escapeXml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);
const tree = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
const namespaces = `xmlns:a="${NS}/drawingml/2006/main" xmlns:r="${NS}/officeDocument/2006/relationships" xmlns:p="${NS}/presentationml/2006/main"`;
const width = 12192000, height = 6858000;

// Image-based decks preserve projection on computers with different fonts.
// The editable source stays in the original service project.
async function imagePowerPoint(slides) {
  if (!Array.isArray(slides) || !slides.length || slides.length > 2000) throw new Error('Invalid fallback slide count.');
  const zip = new JSZip();
  let types = '', ids = '';
  let slideRelationships = rel('rId1', 'slideMaster', 'slideMasters/slideMaster1.xml');
  for (let index = 0; index < slides.length; index += 1) {
    const number = index + 1, slide = slides[index];
    if (!Buffer.isBuffer(slide.image) || !slide.image.length) throw new Error('A fallback slide image is missing.');
    ids += `<p:sldId id="${255 + number}" r:id="rId${number + 1}"/>`;
    slideRelationships += rel(`rId${number + 1}`, 'slide', `slides/slide${number}.xml`);
    types += `<Override PartName="/ppt/slides/slide${number}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`;
    zip.file(`ppt/media/image${number}.jpg`, slide.image);
    zip.file(`ppt/slides/slide${number}.xml`, `${head}<p:sld ${namespaces}><p:cSld name="${escapeXml(slide.title || `Slide ${number}`)}"><p:spTree>${tree}<p:pic><p:nvPicPr><p:cNvPr id="2" name="Slide image" descr="${escapeXml(slide.title || '')}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${width}" cy="${height}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`);
    zip.file(`ppt/slides/_rels/slide${number}.xml.rels`, relationships(rel('rId1', 'image', `../media/image${number}.jpg`) + rel('rId2', 'slideLayout', '../slideLayouts/slideLayout1.xml')));
  }
  zip.file('_rels/.rels', relationships(rel('rId1', 'officeDocument', 'ppt/presentation.xml')));
  zip.file('ppt/presentation.xml', `${head}<p:presentation ${namespaces}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${ids}</p:sldIdLst><p:sldSz cx="${width}" cy="${height}" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`);
  zip.file('ppt/_rels/presentation.xml.rels', relationships(slideRelationships));
  zip.file('ppt/slideLayouts/slideLayout1.xml', `${head}<p:sldLayout ${namespaces} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${tree}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`);
  zip.file('ppt/slideLayouts/_rels/slideLayout1.xml.rels', relationships(rel('rId1', 'slideMaster', '../slideMasters/slideMaster1.xml')));
  zip.file('ppt/slideMasters/slideMaster1.xml', `${head}<p:sldMaster ${namespaces}><p:cSld><p:spTree>${tree}</p:spTree></p:cSld><p:clrMap accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" bg1="lt1" bg2="lt2" folHlink="folHlink" hlink="hlink" tx1="dk1" tx2="dk2"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`);
  zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', relationships(rel('rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml') + rel('rId2', 'theme', '../theme/theme1.xml')));
  const colors = { dk1: '000000', lt1: 'ffffff', dk2: '222222', lt2: 'eeeeee', accent1: '4488cc', accent2: 'ee8844', accent3: '66aa66', accent4: '9966aa', accent5: '44aaaa', accent6: 'ccaa44', hlink: '0000ff', folHlink: '800080' };
  zip.file('ppt/theme/theme1.xml', `${head}<a:theme xmlns:a="${NS}/drawingml/2006/main" name="SyncShow"><a:themeElements><a:clrScheme name="SyncShow">${Object.entries(colors).map(([name, value]) => `<a:${name}><a:srgbClr val="${value}"/></a:${name}>`).join('')}</a:clrScheme><a:fontScheme name="SyncShow"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="SyncShow"><a:fillStyleLst>${'<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'.repeat(3)}</a:fillStyleLst><a:lnStyleLst>${'<a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>'.repeat(3)}</a:lnStyleLst><a:effectStyleLst>${'<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3)}</a:effectStyleLst><a:bgFillStyleLst>${'<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'.repeat(3)}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`);
  zip.file('[Content_Types].xml', `${head}<Types xmlns="${NS}/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpg" ContentType="image/jpeg"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${types}</Types>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
}
module.exports = { imagePowerPoint };

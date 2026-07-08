// Render a transparent PNG text-overlay via macOS AppKit (no ImageMagick, no
// ffmpeg drawtext needed). Called by generate-videos.mjs:
//   osascript -l JavaScript render-overlay.jxa.js '<json-spec>'
// spec: { width, height, out, items: [{ text, font, size, color?, alpha?,
//         x, y, align? ('left'|'center') }] }
// Coordinates are TOP-LEFT based (converted to AppKit's bottom-left here).
ObjC.import('AppKit');

function run(argv) {
  const spec = JSON.parse(argv[0]);
  const W = spec.width, H = spec.height;

  const img = $.NSImage.alloc.initWithSize($.NSMakeSize(W, H));
  img.lockFocus;

  for (const it of spec.items) {
    const font = $.NSFont.fontWithNameSize(it.font || 'Helvetica', it.size);
    const rgb = it.color || [1, 1, 1];
    const color = $.NSColor.colorWithCalibratedRedGreenBlueAlpha(rgb[0], rgb[1], rgb[2], it.alpha == null ? 1 : it.alpha);
    const attrs = $.NSMutableDictionary.alloc.init;
    attrs.setObjectForKey(font, $.NSFontAttributeName);
    attrs.setObjectForKey(color, $.NSForegroundColorAttributeName);
    const str = $(it.text);

    let x = it.x;
    const measured = str.sizeWithAttributes(attrs);
    if (it.align === 'center') x = (W - measured.width) / 2;
    if (it.align === 'right') x = it.x - measured.width;
    // top-left y → AppKit bottom-left origin
    const y = H - it.y - measured.height;
    str.drawAtPointWithAttributes($.NSMakePoint(x, y), attrs);
  }

  img.unlockFocus;

  const tiff = img.TIFFRepresentation;
  const rep = $.NSBitmapImageRep.imageRepWithData(tiff);
  const png = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $.NSDictionary.dictionary);
  png.writeToFileAtomically($(spec.out), true);
  return spec.out;
}

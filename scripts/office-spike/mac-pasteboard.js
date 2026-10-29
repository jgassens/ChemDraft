ObjC.import('AppKit');
ObjC.import('Foundation');

function hashFile(path) {
  const task = $.NSTask.alloc.init;
  const pipe = $.NSPipe.pipe;
  task.launchPath = '/usr/bin/shasum';
  task.arguments = ['-a', '256', path];
  task.standardOutput = pipe;
  task.launch;
  const output = pipe.fileHandleForReading.readDataToEndOfFile;
  task.waitUntilExit;
  if (task.terminationStatus !== 0) throw new Error('shasum failed');
  return ObjC.unwrap($.NSString.alloc.initWithDataEncoding(output, $.NSUTF8StringEncoding)).split(/\s/)[0];
}

function run(args) {
  const board = $.NSPasteboard.generalPasteboard;
  const mode = args[0];
  if (mode === 'write') {
    if (args.length < 3) throw new Error('write <dir> <type=file>...');
    const item = $.NSPasteboardItem.alloc.init;
    for (const spec of args.slice(2)) {
      const at = spec.indexOf('=');
      if (at < 1 || at === spec.length - 1) throw new Error('Invalid type=file: ' + spec);
      const type = spec.slice(0, at), path = $(args[1]).stringByAppendingPathComponent(spec.slice(at + 1));
      const data = $.NSData.dataWithContentsOfFile(path);
      if (!data) throw new Error('Cannot read ' + ObjC.unwrap(path));
      if (!item.setDataForType(data, $(type))) throw new Error('Cannot set ' + type);
    }
    board.clearContents;
    if (!board.writeObjects($([item]))) throw new Error('Pasteboard write failed');
    return;
  }
  if (mode === 'dump' && args.length === 2) {
    const dir = $(args[1]);
    if (!$.NSFileManager.defaultManager.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(dir, true, $(), null)) throw new Error('Cannot create output directory');
    const records = [], items = board.pasteboardItems;
    for (let i = 0; i < Number(items.count); i++) {
      const item = items.objectAtIndex(i), types = item.types;
      for (let j = 0; j < Number(types.count); j++) {
        const type = ObjC.unwrap(types.objectAtIndex(j));
        const data = item.dataForType($(type));
        if (!data || data.isNil()) { records.push({ type, itemIndex: i, note: 'No data' }); continue; }
        const filename = `${i}-${j}-${type.replace(/[^A-Za-z0-9._-]/g, '_')}`;
        const path = dir.stringByAppendingPathComponent(filename);
        if (!data.writeToFileAtomically(path, true)) throw new Error('Cannot write ' + filename);
        records.push({ type, itemIndex: i, file: filename, size: Number(data.length), sha256: hashFile(ObjC.unwrap(path)) });
      }
    }
    const index = $(JSON.stringify(records, null, 2));
    if (!index.writeToFileAtomicallyEncodingError(dir.stringByAppendingPathComponent('index.json'), true, $.NSUTF8StringEncoding, null)) throw new Error('Cannot write index.json');
    return;
  }
  throw new Error('Usage: write <dir> <type=file>... | dump <outdir>');
}

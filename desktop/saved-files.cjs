const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { ClientError } = require('./backend.cjs');
class SavedFiles {
  #files = new Map();
  add(file) { const handle = randomUUID(); this.#files.set(handle, { path: file, realPath: fs.realpathSync(file) }); return handle; }
  clear() { this.#files.clear(); }
  get(handle) {
    const record = typeof handle === 'string' ? this.#files.get(handle) : undefined;
    if (!record || !fs.existsSync(record.path) || !fs.lstatSync(record.path).isFile() || fs.realpathSync(record.path) !== record.realPath) throw new ClientError(404, '已保存的文件不存在，请重新保存。');
    return record.path;
  }
}
module.exports = { SavedFiles };

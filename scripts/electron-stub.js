'use strict';
/**
 * 无界面测试用：electron/*.js 在纯 node 下 require('electron') 会被重定向到这里
 * （见 test-attach.js 顶部的 Module._resolveFilename 钩子）。
 * 只实现被测试代码真正用到的几个方法，别把它当 electron 的模拟层来扩。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = process.env.TEST_USERDATA || fs.mkdtempSync(path.join(os.tmpdir(), 'baton-test-'));
fs.mkdirSync(dir, { recursive: true });

module.exports = {
  app: {
    getPath: () => dir,
    getVersion: () => '0.0.0-test',
    getLocale: () => 'en',
    isPackaged: false,
  },
};

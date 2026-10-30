'use strict';
/**
 * 无界面测试的公共钩子：把 require('electron') 指到 scripts/electron-stub.js，
 * 这样 electron/*.js 可以直接在纯 node 下跑。
 * 用法：先设 process.env.TEST_USERDATA，再 require('./test-hook')。
 */
const Module = require('module');
const stub = require.resolve('./electron-stub.js');
const origResolve = Module._resolveFilename;

Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron') return stub;
  return origResolve.call(this, request, ...rest);
};

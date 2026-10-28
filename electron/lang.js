'use strict';
/**
 * 主进程给界面看的文字（系统提示、报错、安装日志）跟着界面语言走。
 * 写法是就地给出两种语言：L('中文', 'English')，读代码时两边都看得见，不用来回查 key。
 * 发给模型的 prompt 不走这里 —— 那部分换语言会影响交班 / 决策标记的识别，单独处理。
 */
let app = null;
try {
  app = require('electron').app || null; // 纯 node 跑测试时没有 app，按中文处理
} catch {}

let pref = 'auto'; // 'auto' | 'zh' | 'en'，和设置里的「界面语言」同步

function setLang(v) {
  pref = v || 'auto';
}

function isEn() {
  const v = pref === 'auto' ? (app && app.getLocale ? app.getLocale() : 'zh') : pref;
  return !String(v || 'zh').toLowerCase().startsWith('zh');
}

const L = (zh, en) => (isEn() ? en : zh);

module.exports = { L, setLang, isEn };

// wasm 签名模块：在 vm 沙箱里伪装浏览器环境计算 get_sign
// 原站 wasm 会探测 document/location/process/Buffer/require/navigator.webdriver，
// 必须让它看到真实浏览器特征，否则算出的签名无效
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const wasmBytes = fs.readFileSync(path.join(__dirname, "wasm_encrypt.wasm"));

// 沙箱内运行的 glue（与原站 index.js 里的 wasm-bindgen 胶水一致）
const glueSrc = `
// 伪装全局对象的构造器名：真实浏览器里 globalThis.constructor.name === 'Window'
Object.defineProperty(globalThis, 'constructor', {
  value: class Window {},
  configurable: true,
});
let En, Tu = 0;
const te = new TextEncoder();
const td = new TextDecoder("utf-8");
let dv0 = null;

function W1() {
  if (dv0 === null || dv0.buffer !== En.memory.buffer) dv0 = new DataView(En.memory.buffer);
  return dv0;
}
function Vh(arg, malloc, realloc) {
  let len = arg.length;
  let ptr = malloc(len, 1) >>> 0;
  const mem = new Uint8Array(En.memory.buffer);
  let offset = 0;
  for (; offset < len; offset++) {
    const code = arg.charCodeAt(offset);
    if (code > 0x7f) break;
    mem[ptr + offset] = code;
  }
  if (offset !== len) {
    if (offset !== 0) arg = arg.slice(offset);
    len = offset;
    const buf = te.encode(arg);
    ptr = realloc(ptr, len, (len += buf.length), 1) >>> 0;
    new Uint8Array(En.memory.buffer, ptr + len - buf.length, buf.length).set(buf);
    Tu = len;
    return ptr;
  }
  Tu = len;
  return ptr;
}
function Sd(ptr, len) {
  len = len >>> 0;
  return td.decode(new Uint8Array(En.memory.buffer, ptr, len));
}
function ts(x) { return x == null; }
function Ei(obj) {
  const idx = En.__externref_table_alloc();
  En.__wbindgen_externrefs.set(idx, obj);
  return idx;
}
function sv(f, a) {
  try { return f(...a); } catch (e) { En.__wbindgen_exn_store(Ei(e)); }
}
const imports = {
  "./wasm_encrypt_bg.js": {
    __wbg___wbindgen_boolean_get_c0f3f60bac5a78d1: (t) => {
      const o = typeof t === "boolean" ? t : void 0;
      return ts(o) ? 16777215 : o ? 1 : 0;
    },
    __wbg___wbindgen_is_undefined_52709e72fb9f179c: (t) => t === void 0,
    __wbg___wbindgen_string_get_395e606bd0ee4427: (t, n) => {
      const s = typeof n === "string" ? n : void 0;
      const r = ts(s) ? 0 : Vh(s, En.__wbindgen_malloc, En.__wbindgen_realloc);
      W1().setInt32(t + 4, Tu, true);
      W1().setInt32(t + 0, r, true);
    },
    __wbg___wbindgen_throw_6ddd609b62940d55: (t, n) => { throw new Error(Sd(t, n)); },
    __wbg_getOwnPropertyDescriptor_99c5c66035afe95e: function () {
      return sv((t, n) => Reflect.getOwnPropertyDescriptor(t, n), arguments);
    },
    __wbg_get_3ef1eba1850ade27: function () {
      return sv((t, n) => Reflect.get(t, n), arguments);
    },
    __wbg_has_926ef2ff40b308cf: function () {
      return sv((t, n) => Reflect.has(t, n), arguments);
    },
    __wbg_new_no_args_d15c5c26a5dbe2e7: (t, n) => new Function(Sd(t, n))(),
    __wbg_static_accessor_GLOBAL_8adb955bd33fac2f: () => {
      const t = typeof global === "undefined" ? null : global;
      return ts(t) ? 0 : Ei(t);
    },
    __wbg_static_accessor_GLOBAL_THIS_ad356e0db91c7913: () => {
      const t = typeof globalThis === "undefined" ? null : globalThis;
      return ts(t) ? 0 : Ei(t);
    },
    __wbg_static_accessor_SELF_f207c857566db248: () => {
      const t = typeof self === "undefined" ? null : self;
      return ts(t) ? 0 : Ei(t);
    },
    __wbg_static_accessor_WINDOW_bb9f1ba69d61b386: () => {
      const t = typeof window === "undefined" ? null : window;
      return ts(t) ? 0 : Ei(t);
    },
    __wbg_toString_04ebde4c127f09ae: (t) => t.toString(),
    __wbindgen_cast_0000000000000001: (t, n) => Sd(t, n),
    __wbindgen_init_externref_table: () => {
      const t = En.__wbindgen_externrefs;
      const n = t.grow(4);
      t.set(0, void 0); t.set(n + 0, void 0); t.set(n + 1, null); t.set(n + 2, true); t.set(n + 3, false);
    },
  },
};

async function __init(bytes) {
  const { instance } = await WebAssembly.instantiate(bytes, imports);
  En = instance.exports;
  return true;
}
function __getSign(time, openId) {
  let n, o;
  try {
    const a = Vh(time, En.__wbindgen_malloc, En.__wbindgen_realloc), r = Tu;
    const l = Vh(openId, En.__wbindgen_malloc, En.__wbindgen_realloc), i = Tu;
    const u = En.get_sign(a, r, l, i);
    n = u[0]; o = u[1];
    return Sd(u[0], u[1]);
  } finally {
    En.__wbindgen_free(n, o, 1);
  }
}
`;

function makeContext(openId) {
  const sandbox = {
    TextEncoder,
    TextDecoder,
    WebAssembly,
    console,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.global = sandbox;
  // 用类实例伪装 DOM 对象：wasm 会检查 navigator.constructor.name === 'Navigator'
  class Document {}
  class Location {}
  class Navigator {}
  sandbox.document = Object.assign(new Document(), {
    cookie: "openId=" + openId,
    referrer: "",
    addEventListener: () => {},
  });
  sandbox.location = Object.assign(new Location(), {
    href: "https://order.hersweetie.com/feishu/home",
    origin: "https://order.hersweetie.com",
    protocol: "https:",
    host: "order.hersweetie.com",
    hostname: "order.hersweetie.com",
    pathname: "/feishu/home",
  });
  sandbox.navigator = Object.assign(new Navigator(), {
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    language: "zh-CN",
    languages: ["zh-CN", "zh"],
    platform: "Win32",
    webdriver: false,
  });
  sandbox.__bytes = wasmBytes;
  // 刻意不给 process / Buffer / require —— 浏览器里没有
  return vm.createContext(sandbox);
}

let ctx = null;

module.exports = {
  async init(openId) {
    ctx = makeContext(openId || "");
    vm.runInContext(glueSrc, ctx);
    await vm.runInContext("__init(__bytes)", ctx, { timeout: 10000 });
    return true;
  },
  getSign(time, openId) {
    if (!ctx) throw new Error("先调用 init(openId)");
    return vm.runInContext(
      `__getSign(${JSON.stringify(String(time))}, ${JSON.stringify(String(openId))})`,
      ctx,
      { timeout: 10000 }
    );
  },
};

// 命令行自测: node signer.js <time> <openId>
if (require.main === module) {
  const time = process.argv[2] || String(Math.round(Date.now() / 1000));
  const openId = process.argv[3] || "test_openid";
  module.exports.init(openId).then(() => {
    console.log(JSON.stringify({ time, openId, sign: module.exports.getSign(time, openId) }));
  });
}

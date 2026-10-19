// ESLint 扁平配置：扩展本体是浏览器里的经典 <script>（IIFE + window 挂载），
// docs/ 下的测试是 Node ESM，两套环境分别声明，避免大量误报。
import js from '@eslint/js';
import globals from 'globals';

// 酒馆运行时与扩展加载器暴露的全局对象；新增依赖时在这里补，别写 eslint-disable。
const tavernGlobals = {
  SillyTavern: 'readonly',
  toastr: 'readonly',
  $: 'readonly',
  jQuery: 'readonly',
  eventSource: 'readonly',
};

const sharedRules = {
  // 各模块用 IIFE 包住，函数/变量经常为跨模块约定而保留，未使用只提示不阻断。
  'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true, allowTaggedTemplates: true }],
  'no-prototype-builtins': 'off',
  'no-inner-declarations': 'off',
  'no-async-promise-executor': 'off',
  'no-control-regex': 'off',
  'require-yield': 'off',
  // 旧版内联绑定以 if (false) 段保留作参考，常量条件是有意为之。
  'no-constant-condition': 'off',
  // 正则/字符串里存在无害的 \/ 转义。
  'no-useless-escape': 'off',
  // 中文提示文本里的全角空格属于内容，不是排版错误。
  'no-irregular-whitespace': ['error', { skipStrings: true, skipComments: true, skipRegExps: true, skipTemplates: true }],
  // 事件处理器里重复用 var scope/s 是既有写法，只提示不阻断。
  'no-redeclare': 'warn',
  // 只保留当前代码已整体满足的少量格式规则；缩进、对齐等留给编辑器（.editorconfig），
  // 避免一次性重排 1.1 MB 既有代码。
  'quotes': ['error', 'single', { avoidEscape: true, allowTemplateLiterals: true }],
  'semi': ['error', 'always'],
  'object-curly-spacing': ['error', 'always'],
  'array-bracket-spacing': ['error', 'never'],
  'space-in-parens': ['error', 'never'],
  'no-trailing-spaces': 'error',
  'eol-last': ['error', 'always'],
  'no-multiple-empty-lines': ['error', { max: 2, maxEOF: 1, maxBOF: 0 }],
  'template-curly-spacing': ['error', 'never'],
  'rest-spread-spacing': ['error', 'never'],
};

export default [
  {
    // 开发环境产物与工具缓存不参与检查；docs 下的 Markdown 同理。
    ignores: [
      'node_modules/**',
      '.git/**',
      '.mimosa/**',
      '.zcode/**',
      '.claude/**',
      '.dsh-acl-repair/**',
    ],
  },
  js.configs.recommended,
  {
    // 扩展本体：浏览器经典脚本
    files: ['*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        ...tavernGlobals,
      },
    },
    rules: sharedRules,
  },
  {
    // Node 侧的校验脚本与测试
    files: ['scripts/**/*.mjs', 'docs/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...globals.node,
        // 冒烟测试先给 global 挂上假的 window/document，再 import 浏览器模块。
        window: 'readonly',
        document: 'readonly',
      },
    },
    rules: {
      ...sharedRules,
      // 测试脚本允许 console 输出与较长的断言消息。
      'no-console': 'off',
    },
  },
];

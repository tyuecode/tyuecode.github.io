/* brushtrokes build — 资源版本号
 *
 * GitHub Pages 给静态资源发 max-age=14400 的强缓存，且没有文件指纹。
 * 一旦更新了 core.js / render.js / worker.js，老访客会在最长 4 小时内
 * 继续用旧的脚本配新的页面，出现「选了风格却还是油画」这类问题。
 *
 * 解决办法：所有脚本引用都带上 ?v=BUILD 查询串，每次发布改 BUILD 值即可
 * 让浏览器当成全新 URL 去取。这里集中管理，避免各处漏改。
 */
window.OIL_BUILD = '20261111-brushtrokes';

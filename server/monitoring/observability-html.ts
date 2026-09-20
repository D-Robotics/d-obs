/**
 * 服务端 HTML 字符串模板的统一转义辅助。
 *
 * 工作台页面脚本走 DOM textContent（天然免疫 XSS），但服务端 SSR 模板
 * （状态页等）是字符串拼接，所有动态插值必须经过 escapeHtml。新页面
 * 不要再各自定义转义函数——从这里导入，防漂移测试盯住调用面。
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, (character) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>
  )[character] ?? character);
}

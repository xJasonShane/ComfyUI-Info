import { createApp } from 'vue'
import App from './App.vue'
import { t } from './locales'
import './style.css'

const app = createApp(App)

// 全局错误兜底：message API 归 App 内部的 Provider 管（见 App.vue 的 MessageBridge），
// 这里直接挂页面级横幅 + 控制台诊断，未捕获的渲染 / 生命周期异常不再静默白屏
app.config.errorHandler = (err, _instance, info) => {
  console.error('[comfyui-info] 未处理的错误:', err, `(触发于: ${info})`)
  let bar = document.getElementById('global-error-bar')
  if (!bar) {
    bar = document.createElement('div')
    bar.id = 'global-error-bar'
    bar.style.cssText =
      'position:fixed;left:0;right:0;bottom:0;z-index:9999;padding:8px 14px;' +
      'background:#b3261e;color:#fff;font:12px/1.6 system-ui,sans-serif;'
    document.body.appendChild(bar)
  }
  bar.textContent = t('app.fatalBanner', {
    msg: err instanceof Error ? err.message : String(err),
  })
}

app.mount('#app')

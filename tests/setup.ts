import { setLocale } from '../src/locales'

// 断言里写死了中文文案，固定语言使测试不随宿主系统语言漂移
setLocale('zh')

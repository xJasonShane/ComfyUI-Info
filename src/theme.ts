/**
 * 主题单一来源（D5）：主题色只在本表定义一份，同时产出
 * naive-ui 的 GlobalThemeOverrides 与注入 :root 的 CSS 变量。
 * style.css 里同名变量的静态声明仅作无 JS 首帧回退，值必须与本表一致——
 * 运行时以本表注入的内联变量为准，改色值只需改这里。
 */
import type { GlobalThemeOverrides } from 'naive-ui'

interface ThemePalette {
  /** 页面背景（--bg） */
  bg: string
  /** 主题强调色（--accent / naive primaryColor） */
  accent: string
  /** 悬停态（--accent-hover / primaryColorHover） */
  accentHover: string
  /** 按下态（naive primaryColorPressed） */
  accentPressed: string
}

const DARK: ThemePalette = {
  bg: '#131110',
  accent: '#e8a33d',
  accentHover: '#f2b558',
  accentPressed: '#d18f2c',
}

const LIGHT: ThemePalette = {
  bg: '#f5f1e9',
  accent: '#b4741f',
  accentHover: '#c98427',
  accentPressed: '#9a621a',
}

export function themeOverrides(dark: boolean): GlobalThemeOverrides {
  const p = dark ? DARK : LIGHT
  return {
    common: {
      primaryColor: p.accent,
      primaryColorHover: p.accentHover,
      primaryColorPressed: p.accentPressed,
      primaryColorSuppl: p.accent,
      borderRadius: '8px',
    },
  }
}

/** 把主题色同步为 :root 内联 CSS 变量（覆盖样式表声明，保证与 naive 主题同源） */
export function applyThemeVariables(dark: boolean): void {
  const p = dark ? DARK : LIGHT
  const root = document.documentElement.style
  root.setProperty('--bg', p.bg)
  root.setProperty('--accent', p.accent)
  root.setProperty('--accent-hover', p.accentHover)
}

;(function () {
  var themeId = localStorage.getItem("agent-company.theme-id") || "agent-company"
  var scheme = localStorage.getItem("agent-company.color-scheme") || "system"
  var isDark = scheme === "dark" || (scheme === "system" && matchMedia("(prefers-color-scheme: dark)").matches)
  var mode = isDark ? "dark" : "light"

  document.documentElement.dataset.theme = themeId
  document.documentElement.dataset.colorScheme = mode

  if (themeId === "agent-company") return

  var css = localStorage.getItem("agent-company.theme-css-" + mode)
  if (!css) return

  var style = document.createElement("style")
  style.id = "agent-company-theme-preload"
  style.textContent =
    ":root{color-scheme:" +
    mode +
    ";--text-mix-blend-mode:" +
    (isDark ? "plus-lighter" : "multiply") +
    ";" +
    css +
    "}"
  document.head.appendChild(style)
})()

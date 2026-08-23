export default defineNuxtPlugin(() => {
  if (!("serviceWorker" in navigator)) return
  onNuxtReady(() => {
    navigator.serviceWorker.register("/sw.js", {
      scope: "/",
      updateViaCache: "none",
    })
      .then(registration => registration.update())
      .catch(error => console.error("Agent Company service worker registration failed", error))
  })
})

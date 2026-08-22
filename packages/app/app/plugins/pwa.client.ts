export default defineNuxtPlugin(async () => {
  if (!("serviceWorker" in navigator)) return
  const registration = await navigator.serviceWorker.register("/sw.js", {
    scope: "/",
    updateViaCache: "none",
  })
  await registration.update()
})

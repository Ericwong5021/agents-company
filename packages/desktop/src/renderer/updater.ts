export async function runUpdater({ alertOnFail }: { alertOnFail: boolean }) {
  try {
    await window.api.runUpdater(alertOnFail)
  } catch {
    if (alertOnFail) window.alert("Unable to check for updates.")
  }
}

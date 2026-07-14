import { Link, Meta } from "@solidjs/meta"

export const Favicon = () => {
  return (
    <>
      <Link rel="icon" type="image/png" href="/agent-company-icon-192.png" sizes="192x192" />
      <Link rel="icon" type="image/svg+xml" href="/agent-company-mark.svg" />
      <Link rel="apple-touch-icon" sizes="180x180" href="/agent-company-icon-180.png" />
      <Link rel="manifest" href="/site.webmanifest" />
      <Meta name="apple-mobile-web-app-title" content="Agent Company" />
    </>
  )
}

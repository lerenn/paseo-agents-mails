import type { PluginClientContext } from "@getpaseo/plugin/client";
import { MailScreen, MailSidebarItem, SCREEN_ID } from "./client/screen";

export default function contribute(client: PluginClientContext) {
  client.addScreen({ id: SCREEN_ID, title: "Mail", Component: MailScreen });
  client.addSidebarHeaderItem({ id: SCREEN_ID, title: "Mail", Component: MailSidebarItem });
  return () => {};
}

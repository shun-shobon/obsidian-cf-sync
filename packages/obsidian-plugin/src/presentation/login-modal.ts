import { Modal, Platform, type App } from "obsidian";

import { t } from "../i18n";

class LoginModal extends Modal {
  private closed = false;

  override onOpen() {
    this.titleEl.setText(t(($) => $.ui.loginInBrowser));
    this.contentEl.createEl("p", { text: t(($) => $.ui.preparingLogin) });
  }

  ready(url: string) {
    if (this.closed) {
      return;
    }

    this.contentEl.empty();
    this.contentEl.createEl("p", { text: t(($) => $.ui.loginReady) });
    const link = this.contentEl.createEl("a", {
      href: url,
      text: t(($) => $.ui.loginInBrowser),
    });

    link.addEventListener("click", (event) => {
      if (Platform.isDesktopApp) {
        event.preventDefault();
        window.open(url, "_external");
      }

      // Let the mobile link's default navigation run before removing it.
      setTimeout(() => this.close(), 0);
    });
  }

  override onClose() {
    this.closed = true;
    this.contentEl.empty();
  }
}

export async function loginInBrowser(app: App, prepare: () => Promise<string>): Promise<void> {
  const modal = new LoginModal(app);
  modal.open();

  try {
    modal.ready(await prepare());
  } catch (error) {
    modal.close();
    throw error;
  }
}

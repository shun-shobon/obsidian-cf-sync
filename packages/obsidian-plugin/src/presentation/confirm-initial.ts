import { Modal, Setting, type App } from "obsidian";

import { t } from "../i18n";

class ConfirmInitialModal extends Modal {
  private accepted = false;

  constructor(
    app: App,
    private readonly paths: string[],
    private readonly resolve: (accepted: boolean) => void,
  ) {
    super(app);
  }

  override onOpen() {
    this.titleEl.setText(t(($) => $.ui.confirmInitialTitle));
    this.contentEl.createEl("p", {
      text: t(($) => $.ui.confirmInitialDescription),
    });
    const list = this.contentEl.createEl("ul");

    for (const path of this.paths) {
      list.createEl("li", { text: path });
    }

    new Setting(this.contentEl)
      .addButton((button) =>
        button.setButtonText(t(($) => $.ui.cancel)).onClick(() => this.close()),
      )
      .addButton((button) =>
        button
          .setButtonText(t(($) => $.ui.keepBothAndSync))
          .setCta()
          .onClick(() => {
            this.accepted = true;
            this.close();
          }),
      );
  }

  override onClose() {
    this.resolve(this.accepted);
    this.contentEl.empty();
  }
}

export function confirmInitial(app: App, paths: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    new ConfirmInitialModal(app, paths, resolve).open();
  });
}

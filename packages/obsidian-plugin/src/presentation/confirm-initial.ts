import { Modal, Setting, type App } from "obsidian";

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
    this.titleEl.setText("初回同期の内容確認");
    this.contentEl.createEl("p", {
      text: "同じパスに異なる内容があります。両方の内容を別名で保護して同期します。",
    });
    const list = this.contentEl.createEl("ul");
    for (const path of this.paths) list.createEl("li", { text: path });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("キャンセル").onClick(() => this.close()))
      .addButton((button) =>
        button
          .setButtonText("両方を保持して同期")
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

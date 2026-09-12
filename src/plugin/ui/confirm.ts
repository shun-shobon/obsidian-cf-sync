import { Modal, Setting, type App } from "obsidian";
export function confirmInitial(app: App, paths: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    class Confirm extends Modal {
      private accepted = false;
      override onOpen() {
        this.titleEl.setText("初回同期の内容確認");
        this.contentEl.createEl("p", {
          text: "同じパスに異なる内容があります。両方の内容を別名で保護して同期します。",
        });
        const list = this.contentEl.createEl("ul");
        for (const path of paths) list.createEl("li", { text: path });
        new Setting(this.contentEl)
          .addButton((b) => b.setButtonText("キャンセル").onClick(() => this.close()))
          .addButton((b) =>
            b
              .setButtonText("両方を保持して同期")
              .setCta()
              .onClick(() => {
                this.accepted = true;
                this.close();
              }),
          );
      }
      override onClose() {
        resolve(this.accepted);
        this.contentEl.empty();
      }
    }
    new Confirm(app).open();
  });
}

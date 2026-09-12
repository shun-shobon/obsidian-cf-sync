import type { Content } from "@cf-sync/protocol";

import { materializeText } from "../service/text-content";
import type { VaultArchive } from "../usecase/ports";

import { BlobStorage } from "./blob-storage";

export class R2VaultArchive implements VaultArchive {
  constructor(private readonly bucket: R2Bucket) {}

  async write(vaultId: string, path: string, content: Content): Promise<void> {
    const key = `vaults/${vaultId}/files/${path}`;

    if (content.kind === "text") {
      await this.bucket.put(key, materializeText(content.update));
      return;
    }

    const blobs = new BlobStorage(this.bucket, vaultId);
    const object = await blobs.get(content.blob.key);

    await this.bucket.put(key, object.body);
  }

  async delete(vaultId: string, path: string): Promise<void> {
    await this.bucket.delete(`vaults/${vaultId}/files/${path}`);
  }

  collectUnreferenced(vaultId: string, referenced: Set<string>): Promise<number | null> {
    return new BlobStorage(this.bucket, vaultId).collectUnreferenced(referenced);
  }
}

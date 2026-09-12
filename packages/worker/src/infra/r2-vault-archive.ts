import type { Content } from "@cf-sync/protocol";

import { materializeText } from "../service/text-content";
import type { VaultArchive } from "../usecase/ports";

import { BlobStorage } from "./blob-storage";

export class R2VaultArchive implements VaultArchive {
  constructor(private readonly bucket: R2Bucket) {}

  async write(vaultId: string, path: string, content: Content): Promise<void> {
    const body =
      content.kind === "text"
        ? materializeText(content.update)
        : (await new BlobStorage(this.bucket, vaultId).get(content.blob.key)).body;
    await this.bucket.put(`vaults/${vaultId}/files/${path}`, body);
  }

  async delete(vaultId: string, path: string): Promise<void> {
    await this.bucket.delete(`vaults/${vaultId}/files/${path}`);
  }

  collectUnreferenced(vaultId: string, referenced: Set<string>): Promise<void> {
    return new BlobStorage(this.bucket, vaultId).collectUnreferenced(referenced);
  }
}

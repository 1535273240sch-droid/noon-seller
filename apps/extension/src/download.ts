import { fetchBinary } from "./api";
export async function downloadFile(path: string, filename: string) {
  const response = await fetchBinary(path);
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 15000);
}

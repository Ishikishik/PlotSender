const imageInput = document.querySelector("#image-input");
const imagePreview = document.querySelector("#image-preview");
const imageStatus = document.querySelector("#image-status");

let previewUrl = null;

function clearPreview() {
  imagePreview.hidden = true;
  imagePreview.removeAttribute("src");
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
}

imageInput.addEventListener("change", () => {
  const file = imageInput.files[0];
  if (!file) return;

  clearPreview();
  imageStatus.textContent = "画像を読み込んでいます…";
  previewUrl = URL.createObjectURL(file);
  imagePreview.src = previewUrl;
});

imagePreview.addEventListener("load", () => {
  imagePreview.hidden = false;
  imageStatus.textContent = "";
});

imagePreview.addEventListener("error", () => {
  clearPreview();
  imageInput.value = "";
  imageStatus.textContent = "画像を読み込めませんでした。JPEGやPNGなど、別の画像を選んでください。";
});

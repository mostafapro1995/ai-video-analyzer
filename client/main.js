document.addEventListener("DOMContentLoaded", () => {
  const chatContainer = document.getElementById("chat");
  const inputField = document.getElementById("input");
  const sendButton = document.getElementById("send");
  const uploadImage = document.getElementById("uploadImage");
  const videoInput = document.getElementById("uploadVideo");
  const uploadAudio = document.getElementById("uploadAudio");
  const screenShareBtn = document.getElementById("shareScreen");
  const API_URL = "https://ai-video-analyzer-4mmd.onrender.com";

  let conversationHistory = [];

  function addMessage(sender, text, isHTML = false) {
    const msg = document.createElement("div");
    msg.className = `message ${sender}`;
    msg.innerHTML = isHTML ? text : `<div class="text">${text}</div>`;
    chatContainer.appendChild(msg);
    chatContainer.scrollTop = chatContainer.scrollHeight;
    return msg;
  }

  function attachLoader(msgEl) {
    const loaderHTML = `
      <div class="loader-bubble">
        <div class="loader-dot"></div>
        <div class="loader-dot"></div>
        <div class="loader-dot"></div>
      </div>
    `;
    msgEl.innerHTML = loaderHTML;
    return () => msgEl.remove();
  }

  async function sendMessage() {
    const message = inputField.value.trim();
    if (!message) return;

    addMessage("user", message);
    conversationHistory.push({ role: "user", content: message });
    inputField.value = "";

    const assistMsg = addMessage("assistant", "");
    const stopLoader = attachLoader(assistMsg);

    try {
      const response = await fetch(`${API_URL}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });

      const data = await response.json();
      stopLoader();

      if (response.ok && data.ok && typeof data.response === "string") {
        addMessage("assistant", data.response);
        conversationHistory.push({ role: "assistant", content: data.response });
      } else {
        addMessage("assistant", `⚠️ خطأ: ${data.error || "تعذر معالجة الفيديو."}`);
      }
    } catch (error) {
      stopLoader();
      addMessage("assistant", "⚠️ تعذر الاتصال بالسيرفر. تأكد من تشغيله.");
    }
  }

  async function processVideo(file, prompt = "") {
    if (!file) return;

    addMessage("user", `<video src="${URL.createObjectURL(file)}" controls></video>`, true);

    const assistMsg = addMessage("assistant", "");
    const stopLoader = attachLoader(assistMsg);

    const formData = new FormData();
    formData.append("video", file);
    formData.append("prompt", prompt);

    try {
      const res = await fetch(`${API_URL}/upload-video`, {
        method: "POST",
        body: formData,
      });

      const data = await res.json();
      stopLoader();

      if (res.ok && data.ok && data.response) {
        addMessage("assistant", data.response);
        conversationHistory.push({ role: "assistant", content: data.response });
      } else {
        addMessage("assistant", `⚠️ خطأ: ${data.error || "تعذر معالجة الفيديو."}`);
      }
    } catch (error) {
      stopLoader();
      addMessage("assistant", "⚠️ فشل رفع الفيديو. تأكد من تشغيل السيرفر.");
    }
  }

  async function uploadFile(file, type) {
    if (!file) return;

    if (type === "image") {
      addMessage("user", `<img src="${URL.createObjectURL(file)}" alt="صورة" />`, true);
    } else if (type === "video") {
      addMessage("user", `<video src="${URL.createObjectURL(file)}" controls></video>`, true);
    } else {
      addMessage("user", `🎧 ملف صوتي`);
    }

    const assistMsg = addMessage("assistant", "");
    const stopLoader = attachLoader(assistMsg);

    const formData = new FormData();
    formData.append(type, file);

    try {
      const res = await fetch(`${API_URL}/upload-${type}`, {
        method: "POST",
        body: formData,
      });

      const data = await res.json();
      stopLoader();

      if (res.ok && data.ok && data.response) {
        addMessage("assistant", data.response);
        conversationHistory.push({ role: "assistant", content: data.response });
      } else {
        addMessage("assistant", `⚠️ خطأ: ${data.error || "تعذر معالجة الملف."}`);
      }
    } catch (error) {
      stopLoader();
      addMessage("assistant", `⚠️ فشل رفع ${type}. تأكد من تشغيل السيرفر.`);
    }
  }

  async function startScreenRecording() {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });

      const chunks = [];
      const recorder = new MediaRecorder(stream, { mimeType: "video/webm" });

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };

      recorder.onstop = async () => {
        const blob = new Blob(chunks, { type: "video/webm" });
        const file = new File([blob], "screen-recording.webm", { type: "video/webm" });
        await uploadFile(file, "video");
      };

      recorder.start();
      stream.getVideoTracks()[0].addEventListener("ended", () => recorder.stop());
    } catch (err) {
      console.log("تم إلغاء مشاركة الشاشة:", err.message);
    }
  }

  sendButton.addEventListener("click", sendMessage);
  inputField.addEventListener("keypress", (e) => {
    if (e.key === "Enter") sendMessage();
  });

  uploadImage.addEventListener("change", (e) => uploadFile(e.target.files[0], "image"));
  videoInput.addEventListener("change", (e) => processVideo(e.target.files[0]));
  uploadAudio.addEventListener("change", (e) => uploadFile(e.target.files[0], "audio"));

  screenShareBtn.addEventListener("click", startScreenRecording);
});

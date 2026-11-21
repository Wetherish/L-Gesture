export async function openCamera(video, onEnded) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera access requires localhost or HTTPS.');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false,
    });
    video.srcObject = stream;
    await video.play();
    stream.getVideoTracks()[0].addEventListener('ended', onEnded, { once: true });
  } catch (error) {
    closeCamera(video);
    if (error.name === 'NotAllowedError') throw new Error('Allow camera access in your browser and try again.');
    throw new Error('Could not start the camera. You can use a sample photo.');
  }
}

export function closeCamera(video) {
  video.srcObject?.getTracks().forEach(track => track.stop());
  video.srcObject = null;
}

export function captureSnapshot(video, area) {
  if (!video.videoWidth || video.readyState < 2) throw new Error('Wait for the live camera feed before taking a photo.');
  const viewport = video.getBoundingClientRect();
  if (typeof area.getBoundingClientRect === 'function') {
    const bounds = area.getBoundingClientRect();
    area = {
      x: (bounds.left - viewport.left) / viewport.width,
      y: (bounds.top - viewport.top) / viewport.height,
      width: bounds.width / viewport.width,
      height: bounds.height / viewport.height,
    };
  }
  const scale = Math.max(viewport.width / video.videoWidth, viewport.height / video.videoHeight);
  const visibleWidth = viewport.width / scale;
  const visibleHeight = viewport.height / scale;
  const width = area.width * visibleWidth;
  const height = area.height * visibleHeight;
  const x = (video.videoWidth - visibleWidth) / 2 + area.x * visibleWidth;
  const y = (video.videoHeight - visibleHeight) / 2 + area.y * visibleHeight;
  const outputScale = Math.min(1, 640 / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * outputScale));
  canvas.height = Math.max(1, Math.round(height * outputScale));
  const context = canvas.getContext('2d');
  context.drawImage(video, x, y, width, height, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.88);
}

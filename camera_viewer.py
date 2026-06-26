import tkinter as tk
from tkinter import ttk, messagebox
import cv2
import threading
import queue
import time
from PIL import Image, ImageTk

RTSP_URL = "rtsp://admin:Abacate12@192.168.15.17:554/onvif1"


class CameraViewer:
    def __init__(self, root):
        self.root = root
        self.root.title("Câmera IP - Visualizador")
        self.root.configure(bg="#1a1a2e")
        self.root.resizable(True, True)

        self.cap = None
        self.running = False
        self.frame_queue = queue.Queue(maxsize=2)
        self.reconnect_delay = 3
        self.fps_counter = 0
        self.fps_time = time.time()
        self.current_fps = 0

        self._build_ui()
        self.root.protocol("WM_DELETE_WINDOW", self.on_close)

    def _build_ui(self):
        # --- Top bar ---
        top = tk.Frame(self.root, bg="#16213e", pady=8)
        top.pack(fill="x")

        tk.Label(top, text="📷 Câmera IP", font=("Segoe UI", 14, "bold"),
                 fg="#e94560", bg="#16213e").pack(side="left", padx=16)

        self.status_var = tk.StringVar(value="Desconectado")
        self.status_label = tk.Label(top, textvariable=self.status_var,
                                     font=("Segoe UI", 10), fg="#ff6b6b", bg="#16213e")
        self.status_label.pack(side="left", padx=8)

        self.fps_var = tk.StringVar(value="")
        tk.Label(top, textvariable=self.fps_var, font=("Segoe UI", 10),
                 fg="#4ecca3", bg="#16213e").pack(side="right", padx=16)

        # --- Video canvas ---
        self.canvas = tk.Canvas(self.root, bg="#0f0e17", cursor="crosshair",
                                width=1280, height=720)
        self.canvas.pack(fill="both", expand=True, padx=8, pady=8)

        self.canvas_image_id = self.canvas.create_image(0, 0, anchor="nw")

        # Placeholder text
        self.canvas.create_text(640, 360, text="Clique em CONECTAR para iniciar",
                                font=("Segoe UI", 18), fill="#555577", tag="placeholder")

        # --- Bottom bar ---
        bottom = tk.Frame(self.root, bg="#16213e", pady=6)
        bottom.pack(fill="x")

        self.connect_btn = tk.Button(
            bottom, text="  CONECTAR  ", command=self.toggle_stream,
            font=("Segoe UI", 11, "bold"), bg="#e94560", fg="white",
            activebackground="#c73652", activeforeground="white",
            relief="flat", padx=10, pady=4, cursor="hand2"
        )
        self.connect_btn.pack(side="left", padx=12)

        tk.Button(
            bottom, text="  SNAPSHOT  ", command=self.take_snapshot,
            font=("Segoe UI", 11, "bold"), bg="#0f3460", fg="white",
            activebackground="#0a2a4a", activeforeground="white",
            relief="flat", padx=10, pady=4, cursor="hand2"
        ).pack(side="left", padx=4)

        tk.Label(bottom, text=f"IP: 192.168.15.17  |  Porta: 554",
                 font=("Segoe UI", 9), fg="#888aaa", bg="#16213e").pack(side="right", padx=16)

    def toggle_stream(self):
        if self.running:
            self.stop_stream()
        else:
            self.start_stream()

    def start_stream(self):
        self.running = True
        self.connect_btn.config(text="  PARAR  ", bg="#555577")
        self.set_status("Conectando...", "#ffdd57")

        capture_thread = threading.Thread(target=self._capture_loop, daemon=True)
        capture_thread.start()

        self.root.after(33, self._update_canvas)

    def stop_stream(self):
        self.running = False
        self.connect_btn.config(text="  CONECTAR  ", bg="#e94560")
        self.set_status("Desconectado", "#ff6b6b")
        self.fps_var.set("")

        if self.cap:
            self.cap.release()
            self.cap = None

        self.canvas.delete("frame_image")
        self.canvas.create_text(640, 360, text="Stream encerrado",
                                font=("Segoe UI", 18), fill="#555577", tag="placeholder")

    def _capture_loop(self):
        while self.running:
            try:
                self.cap = cv2.VideoCapture(RTSP_URL, cv2.CAP_FFMPEG)
                self.cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)

                if not self.cap.isOpened():
                    self.root.after(0, lambda: self.set_status("Falha na conexão — retentando...", "#ff6b6b"))
                    time.sleep(self.reconnect_delay)
                    continue

                self.root.after(0, lambda: self.set_status("Conectado  ●", "#4ecca3"))

                while self.running:
                    ret, frame = self.cap.read()
                    if not ret:
                        break

                    frame_rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)

                    if not self.frame_queue.full():
                        self.frame_queue.put(frame_rgb)

                    # FPS count
                    self.fps_counter += 1
                    now = time.time()
                    if now - self.fps_time >= 1.0:
                        self.current_fps = self.fps_counter
                        self.fps_counter = 0
                        self.fps_time = now
                        self.root.after(0, lambda fps=self.current_fps: self.fps_var.set(f"{fps} FPS"))

            except Exception as e:
                self.root.after(0, lambda: self.set_status(f"Erro: {e}", "#ff6b6b"))

            finally:
                if self.cap:
                    self.cap.release()
                    self.cap = None

            if self.running:
                self.root.after(0, lambda: self.set_status("Reconectando...", "#ffdd57"))
                time.sleep(self.reconnect_delay)

    def _update_canvas(self):
        if not self.running:
            return

        try:
            frame = self.frame_queue.get_nowait()
            cw = self.canvas.winfo_width()
            ch = self.canvas.winfo_height()

            if cw > 1 and ch > 1:
                img = Image.fromarray(frame)
                img_ratio = img.width / img.height
                canvas_ratio = cw / ch

                if img_ratio > canvas_ratio:
                    new_w, new_h = cw, int(cw / img_ratio)
                else:
                    new_w, new_h = int(ch * img_ratio), ch

                img = img.resize((new_w, new_h), Image.LANCZOS)
                photo = ImageTk.PhotoImage(img)

                x = (cw - new_w) // 2
                y = (ch - new_h) // 2

                self.canvas.delete("placeholder")
                self.canvas.delete("frame_image")
                self.canvas.create_image(x, y, anchor="nw", image=photo, tag="frame_image")
                self.canvas._photo = photo  # prevent GC
        except queue.Empty:
            pass

        self.root.after(33, self._update_canvas)

    def take_snapshot(self):
        try:
            frame = self.frame_queue.get_nowait()
            filename = f"snapshot_{int(time.time())}.jpg"
            path = f"C:/Users/Eduar/Desktop/{filename}"
            img = Image.fromarray(frame)
            img.save(path)
            messagebox.showinfo("Snapshot", f"Imagem salva em:\n{path}")
        except queue.Empty:
            messagebox.showwarning("Snapshot", "Nenhum frame disponível. Conecte primeiro.")

    def set_status(self, text, color):
        self.status_var.set(text)
        self.status_label.config(fg=color)

    def on_close(self):
        self.running = False
        if self.cap:
            self.cap.release()
        self.root.destroy()


def main():
    root = tk.Tk()
    root.geometry("1280x760")
    app = CameraViewer(root)
    root.mainloop()


if __name__ == "__main__":
    main()

import io

import numpy as np
import streamlit as st
from PIL import Image, ImageChops, ImageEnhance


st.set_page_config(page_title="3DS MPO Wobble Tool", layout="wide")

st.title("3DS MPO Wobble / Overlay Tool")
st.write(
    "Upload a Nintendo 3DS `.mpo` file, adjust crops, and preview the overlay, "
    "difference image, and wobble GIF generated from the stereo pair."
)


def extract_left_right_from_mpo(file_bytes: bytes):
    """Return first two frames from an MPO file as Pillow images."""
    img = Image.open(io.BytesIO(file_bytes))
    frames = []
    try:
        index = 0
        while len(frames) < 2:
            img.seek(index)
            frames.append(img.copy())
            index += 1
    except EOFError:
        pass

    if len(frames) < 2:
        st.error("MPO file appears to have fewer than 2 frames.")
        st.stop()

    return frames[0], frames[1]


def crop_left_right(left: Image.Image, right: Image.Image, crop_px: int):
    """Symmetrically crop from right edge of left image and left edge of right image."""
    w_l, h_l = left.size
    w_r, h_r = right.size

    crop_px = max(0, min(crop_px, min(w_l, w_r) - 1))

    left_cropped = left.crop((0, 0, w_l - crop_px, h_l))
    right_cropped = right.crop((crop_px, 0, w_r, h_r))

    if right_cropped.size != left_cropped.size:
        right_cropped = right_cropped.resize(left_cropped.size, Image.LANCZOS)

    return left_cropped, right_cropped


def make_overlay(left: Image.Image, right: Image.Image) -> Image.Image:
    left_rgba = left.convert("RGBA")
    right_rgba = right.convert("RGBA")
    if right_rgba.size != left_rgba.size:
        right_rgba = right_rgba.resize(left_rgba.size, Image.LANCZOS)
    return Image.blend(left_rgba, right_rgba, alpha=0.5).convert("RGB")


def make_diff(left: Image.Image, right: Image.Image) -> Image.Image:
    left_rgb = left.convert("RGB")
    right_rgb = right.convert("RGB")
    if right_rgb.size != left_rgb.size:
        right_rgb = right_rgb.resize(left_rgb.size, Image.LANCZOS)
    diff = ImageChops.difference(left_rgb, right_rgb)
    return ImageEnhance.Contrast(diff).enhance(2.0)


def calc_diff_score(left: Image.Image, right: Image.Image) -> float:
    """Return mean absolute pixel difference (0–255). Lower = better aligned."""
    left_arr = np.array(left.convert("RGB"), dtype=float)
    right_arr = np.array(right.convert("RGB"), dtype=float)
    if left_arr.shape != right_arr.shape:
        right_pil = Image.fromarray(right_arr.astype("uint8")).resize(
            (left_arr.shape[1], left_arr.shape[0]), Image.LANCZOS
        )
        right_arr = np.array(right_pil, dtype=float)
    return float(np.mean(np.abs(left_arr - right_arr)))


def make_wobble_gif(
    left: Image.Image,
    right: Image.Image,
    wobble_cycles: int,
    frames_per_view: int,
    frame_duration_ms: int,
    crossfade_steps: int,
    scale: float = 0.75,
) -> bytes:
    """Return GIF bytes of wobble animation with crossfade."""
    left_rgba = left.convert("RGBA")
    right_rgba = right.convert("RGBA")
    if right_rgba.size != left_rgba.size:
        right_rgba = right_rgba.resize(left_rgba.size, Image.LANCZOS)

    if 0 < scale < 1.0:
        w, h = left_rgba.size
        new_size = (int(w * scale), int(h * scale))
        left_rgba = left_rgba.resize(new_size, Image.LANCZOS)
        right_rgba = right_rgba.resize(new_size, Image.LANCZOS)

    frames = []

    def add_cycle():
        for _ in range(frames_per_view):
            frames.append(left_rgba.copy())
        for i in range(1, crossfade_steps + 1):
            alpha = i / (crossfade_steps + 1)
            frames.append(Image.blend(left_rgba, right_rgba, alpha))
        for _ in range(frames_per_view):
            frames.append(right_rgba.copy())
        for i in range(1, crossfade_steps + 1):
            alpha = i / (crossfade_steps + 1)
            frames.append(Image.blend(right_rgba, left_rgba, alpha))

    for _ in range(wobble_cycles):
        add_cycle()

    if not frames:
        return b""

    frames_rgb = [f.convert("RGB") for f in frames]
    buf = io.BytesIO()
    frames_rgb[0].save(
        buf,
        format="GIF",
        save_all=True,
        append_images=frames_rgb[1:],
        duration=frame_duration_ms,
        loop=0,
        optimize=True,
    )

    buf.seek(0)
    return buf.getvalue()


uploaded = st.file_uploader("Upload a .mpo file", type=["mpo", "MPO"])

if uploaded is not None:
    cache_key = f"mpo_{uploaded.name}_{uploaded.size}"
    if cache_key not in st.session_state:
        st.session_state[cache_key] = uploaded.read()
    left_img, right_img = extract_left_right_from_mpo(st.session_state[cache_key])

    st.subheader("Original stereo pair")
    col1, col2 = st.columns(2)
    with col1:
        st.caption("Left view")
        st.image(left_img, use_container_width=True)
    with col2:
        st.caption("Right view")
        st.image(right_img, use_container_width=True)

    st.subheader("Crop settings")

    crop_max = min(min(left_img.size[0], right_img.size[0]) - 1, 200)

    _l, col_auto, _r = st.columns([2, 1, 2])
    with col_auto:
        auto_crop = st.button(
            "Minimise Diff Value",
            use_container_width=True,
            help=(
                "Automatically tests every crop value from 0 to the maximum and picks the one "
                "that produces the lowest pixel difference between the two views. "
                "A lower diff score means the images are better aligned. This may take a few seconds."
            ),
        )

    if auto_crop:
        with st.spinner("Searching for optimal crop…"):
            best_crop = 0
            best_score = float("inf")
            progress = st.progress(0)
            for c in range(0, crop_max + 1):
                lc, rc = crop_left_right(left_img, right_img, c)
                score = calc_diff_score(lc, rc)
                if score < best_score:
                    best_score = score
                    best_crop = c
                progress.progress((c + 1) / (crop_max + 1))
            progress.empty()
        st.session_state["best_crop"] = best_crop
        st.success(f"Best crop: **{best_crop}px** — diff score `{best_score:.1f}`")

    default_crop = st.session_state.get("best_crop", 0)
    crop_px = st.slider(
        "Symmetric crop (px) – trims right of LEFT and left of RIGHT",
        min_value=0,
        max_value=crop_max,
        value=default_crop,
        help=(
            "The 3DS cameras are physically offset, so the left and right images don't quite line up. "
            "This crops the inner edge of each image by the same number of pixels — trimming the right "
            "side of the left view and the left side of the right view — so the remaining content overlaps correctly. "
            "Use 'Minimise Diff Vallue' to minimise the overall diff, or adjust the slider until the subject is as black as possible."
        ),
    )

    left_cropped, right_cropped = crop_left_right(left_img, right_img, crop_px)

    overlay_img = make_overlay(left_cropped, right_cropped)
    diff_img = make_diff(left_cropped, right_cropped)
    diff_score = calc_diff_score(left_cropped, right_cropped)

    st.subheader("Overlay and difference (from cropped pair)")
    col5, col6 = st.columns(2)
    with col5:
        st.caption("50/50 overlay")
        st.image(overlay_img, use_container_width=True)
    with col6:
        st.caption("Pixel difference (contrast boosted)")
        st.image(diff_img, use_container_width=True)
        st.markdown(f"**Diff score:** `{diff_score:.1f} / 255`")

    st.subheader("Wobble GIF")
    frames_per_view = st.slider(
        "Frames per static view",
        1, 10, 2,
        help=(
            "How many identical frames are held on the left image and the right image "
            "before transitioning to the other. Higher values create a more pronounced 'snap' "
            "between views; lower values make the animation feel faster and more continuous."
        ),
    )
    frame_duration_ms = st.slider(
        "Frame duration (ms)",
        20, 400, 120, step=10,
        help=(
            "How long each frame is displayed, in milliseconds. "
            "Lower values speed up the overall animation; higher values slow it down. "
            "This applies equally to static frames and crossfade frames."
        ),
    )
    crossfade_steps = st.slider(
        "Crossfade steps",
        0, 10, 4,
        help=(
            "Number of intermediate blend frames inserted between the left and right views. "
            "Set to 0 for a hard cut (classic wobble), or increase for a smoother dissolve transition. "
            "More steps produce a smoother but larger GIF."
        ),
    )

    _l, col_gen, _r = st.columns([2, 1, 2])
    with col_gen:
        generate = st.button("Generate GIF", type="primary", use_container_width=True)

    if generate:
        with st.spinner("Generating wobble GIF…"):
            gif_bytes = make_wobble_gif(
                left_cropped,
                right_cropped,
                wobble_cycles=1,
                frames_per_view=frames_per_view,
                frame_duration_ms=frame_duration_ms,
                crossfade_steps=crossfade_steps,
                scale=0.75,
            )
        st.session_state["gif_bytes"] = gif_bytes

    if "gif_bytes" in st.session_state and st.session_state["gif_bytes"]:
        st.write("")
        st.write("")
        _left, col_preview, _right = st.columns([1, 2, 1])
        with col_preview:
            st.image(st.session_state["gif_bytes"], caption="Wobble preview", use_container_width=True)

        _l, col_btn, _r = st.columns([2, 1, 2])
        with col_btn:
            st.download_button(
                "Download wobble GIF",
                data=st.session_state["gif_bytes"],
                file_name="wobble.gif",
                mime="image/gif",
                use_container_width=True,
            )
import io
import os
import base64

import numpy as np
import streamlit as st
from PIL import Image, ImageChops, ImageEnhance


st.set_page_config(page_title="3DS MPO Wobble Tool", layout="wide")

st.title("3DS MPO Wobble / Overlay Tool")
st.write(
    "Upload a Nintendo 3DS `.mpo` file, adjust crops, and preview the overlay, "
    "difference image, and wobble GIF generated from the stereo pair."
)


# ── Example files ──────────────────────────────────────────────────────────────
# Add more entries here in multiples of 3. Each dict needs:
#   path  – relative path to the .mpo file
#   label – short display name shown on the card
EXAMPLE_FILES = [
    {"path": "examples/example_1.MPO", "label": "Scene 1"},
    {"path": "examples/example_2.MPO", "label": "Scene 2"},
    {"path": "examples/example_3.MPO", "label": "Scene 3"},
]
# ───────────────────────────────────────────────────────────────────────────────

from rembg import remove as rembg_remove

def get_subject_mask(img: Image.Image) -> np.ndarray:
    """Return a boolean mask (H, W) where True = subject pixels."""
    # rembg removes the background, leaving subject with alpha > 0
    result = rembg_remove(img.convert("RGBA"))
    alpha = np.array(result)[:, :, 3]  # extract alpha channel
    return alpha > 10  # threshold to boolean mask


def calc_diff_score(left: Image.Image, right: Image.Image, mask: np.ndarray | None = None) -> float:
    """Return mean absolute pixel difference (0–255). Lower = better aligned."""
    left_arr = np.array(left.convert("RGB"), dtype=float)
    right_arr = np.array(right.convert("RGB"), dtype=float)
    if left_arr.shape != right_arr.shape:
        right_pil = Image.fromarray(right_arr.astype("uint8")).resize(
            (left_arr.shape[1], left_arr.shape[0]), Image.LANCZOS
        )
        right_arr = np.array(right_pil, dtype=float)
    
    diff = np.abs(left_arr - right_arr)
    
    if mask is not None and mask.shape == diff.shape[:2]:
        return float(np.mean(diff[mask]))
    return float(np.mean(diff))

def ternary_search_crop(left_img, right_img, lo, hi, mask=None):
    while hi - lo > 2:
        m1 = lo + (hi - lo) // 3
        m2 = hi - (hi - lo) // 3
        score1 = calc_diff_score(*crop_left_right(left_img, right_img, m1), mask=mask)
        score2 = calc_diff_score(*crop_left_right(left_img, right_img, m2), mask=mask)
        if score1 < score2:
            hi = m2
        else:
            lo = m1

    best_crop, best_score = lo, float("inf")
    for c in range(lo, hi + 1):
        score = calc_diff_score(*crop_left_right(left_img, right_img, c), mask=mask)
        if score < best_score:
            best_score, best_crop = score, c
    return best_crop, best_score

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


# def calc_diff_score(left: Image.Image, right: Image.Image) -> float:
#     """Return mean absolute pixel difference (0–255). Lower = better aligned."""
#     left_arr = np.array(left.convert("RGB"), dtype=float)
#     right_arr = np.array(right.convert("RGB"), dtype=float)
#     if left_arr.shape != right_arr.shape:
#         right_pil = Image.fromarray(right_arr.astype("uint8")).resize(
#             (left_arr.shape[1], left_arr.shape[0]), Image.LANCZOS
#         )
#         right_arr = np.array(right_pil, dtype=float)
#     return float(np.mean(np.abs(left_arr - right_arr)))


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


def pil_to_b64(img: Image.Image, max_width: int = 400) -> str:
    """Resize and encode a PIL image as a base64 JPEG string for embedding in HTML."""
    w, h = img.size
    if w > max_width:
        img = img.resize((max_width, int(h * max_width / w)), Image.LANCZOS)
    buf = io.BytesIO()
    img.convert("RGB").save(buf, format="JPEG", quality=80)
    return base64.b64encode(buf.getvalue()).decode()


def render_example_cards(examples: list[dict]) -> int | None:
    """
    Render a grid of stereo-preview cards for each example MPO.
    Returns the index of the chosen example, or None if none clicked.
    """
    available = [(i, ex) for i, ex in enumerate(examples) if os.path.exists(ex["path"])]
    if not available:
        return None

    st.markdown("#### Or try an example")

    st.markdown("""
    <style>
    .stereo-card {
        position: relative;
        width: 100%;
        aspect-ratio: 4/3;
        border-radius: 10px;
        overflow: hidden;
        cursor: pointer;
        box-shadow: 0 2px 12px rgba(0,0,0,0.18);
        transition: transform 0.18s ease, box-shadow 0.18s ease;
        margin-bottom: 4px;
    }
    .stereo-card:hover {
        transform: translateY(-4px) scale(1.02);
        box-shadow: 0 8px 28px rgba(0,0,0,0.28);
    }
    .stereo-card img {
        position: absolute;
        width: 100%;
        height: 100%;
        object-fit: cover;
    }
    .stereo-card .left-img {
        clip-path: polygon(0 0, 58% 0, 42% 100%, 0 100%);
        z-index: 1;
    }
    .stereo-card .right-img {
        clip-path: polygon(58% 0, 100% 0, 100% 100%, 42% 100%);
        z-index: 1;
    }
    .stereo-card .divider {
        position: absolute;
        left: 50%;
        top: 0; bottom: 0;
        width: 3px;
        background: rgba(255,255,255,0.85);
        transform: translateX(-50%) skewX(-8deg);
        z-index: 2;
        box-shadow: 0 0 8px rgba(255,255,255,0.5);
    }
    .stereo-card .card-label {
        position: absolute;
        bottom: 0; left: 0; right: 0;
        padding: 22px 12px 10px;
        background: linear-gradient(transparent, rgba(0,0,0,0.6));
        color: #fff;
        font-size: 13px;
        font-weight: 600;
        letter-spacing: 0.04em;
        text-align: center;
        z-index: 3;
    }
    .stereo-card .stereo-badge {
        position: absolute;
        top: 8px; right: 8px;
        background: rgba(204, 0, 0, 0.5);
        color: #fff;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.08em;
        padding: 3px 7px;
        border-radius: 4px;
        z-index: 3;
        text-transform: uppercase;
    }
    </style>
    """, unsafe_allow_html=True)

    chosen = None
    for row_start in range(0, len(available), 3):
        row = available[row_start:row_start + 3]
        cols = st.columns(len(row))
        for col, (i, ex) in zip(cols, row):
            with col:
                with open(ex["path"], "rb") as f:
                    mpo_bytes = f.read()
                left_img, right_img = extract_left_right_from_mpo(mpo_bytes)
                left_b64 = pil_to_b64(left_img)
                right_b64 = pil_to_b64(right_img)

                st.markdown(f"""
                <div class="stereo-card">
                    <img class="left-img"  src="data:image/jpeg;base64,{left_b64}">
                    <img class="right-img" src="data:image/jpeg;base64,{right_b64}">
                    <div class="divider"></div>
                    <div class="stereo-badge">3D</div>
                    <div class="card-label">{ex['label']}</div>
                </div>
                """, unsafe_allow_html=True)

                if st.button(f"Load - {ex['label']}", key=f"example_btn_{i}", use_container_width=True):
                    chosen = i

    return chosen


# ── File loading ───────────────────────────────────────────────────────────────

uploaded = st.file_uploader("Upload a .mpo file", type=["mpo", "MPO"])

if uploaded is None:
    chosen_idx = render_example_cards(EXAMPLE_FILES)
    if chosen_idx is not None:
        ex = EXAMPLE_FILES[chosen_idx]
        with open(ex["path"], "rb") as f:
            st.session_state["example_bytes"] = f.read()
        st.session_state["example_label"] = ex["label"]
        st.session_state["using_example"] = True
        st.rerun()

if uploaded is not None:
    cache_key = f"mpo_{uploaded.name}_{uploaded.size}"
    if cache_key not in st.session_state:
        st.session_state[cache_key] = uploaded.read()
    st.session_state.pop("using_example", None)
    active_bytes_key = cache_key
elif st.session_state.get("using_example") and "example_bytes" in st.session_state:
    active_bytes_key = "example_bytes"
else:
    active_bytes_key = None

# ── Main app ───────────────────────────────────────────────────────────────────

if active_bytes_key is not None:
    if st.session_state.get("using_example"):
        label = st.session_state.get("example_label", "example")
        st.info(f"Showing example: **{label}**. Upload your own `.mpo` file above to use your own photos.")

    left_img, right_img = extract_left_right_from_mpo(st.session_state[active_bytes_key])

    st.subheader("Original stereo pair")
    col1, col2 = st.columns(2)
    with col1:
        st.caption("Left view")
        st.image(left_img, use_container_width=True)
    with col2:
        st.caption("Right view")
        st.image(right_img, use_container_width=True)

    st.subheader("Crop settings")

    st.markdown("""
    The 3DS camera captures two slightly offset images simultaneously - one for each eye.
    Without alignment, this offset makes the wobble GIF look jittery rather than three-dimensional.

    **How cropping fixes this:** by trimming the inner edge of each image (the right side of the
    left image, and the left side of the right image), the two frames can be brought into alignment.

    **What to aim for:** a good alignment has the *subject* as overlapped as possible, and the
    *background* as different as possible — this is what creates the 3D parallax effect where the
    background appears to shift around a fixed subject.

    **How to use the crop tool:**
    - Use the **◀ ▶ arrows** to fine-tune the crop one pixel at a time
    - Watch the **overlay** and **diff** images below as you adjust
    - Aim for the subject to appear as sharp in the overlay image and dark as possible in the diff image
    - **Minimise Diff Value** gives a good starting point, but optimises for the lowest *overall*
    difference rather than the subject specifically - so manual fine-tuning often improves the result
    """)

    crop_max = min(min(left_img.size[0], right_img.size[0]) - 1, 200)

    if "crop_px" not in st.session_state:
        st.session_state["crop_px"] = 0

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
        with st.spinner("Detecting subject…"):
            subject_mask = get_subject_mask(left_img)
        with st.spinner("Searching for optimal crop…"):
            best_crop, best_score = ternary_search_crop(left_img, right_img, 0, crop_max, subject_mask)
        st.session_state["crop_px"] = best_crop
        st.session_state["auto_crop_msg"] = f"Best crop: **{best_crop}px** — diff score `{best_score:.1f}`"
        st.rerun()

    if st.session_state.get("auto_crop_msg"):
        st.success(st.session_state["auto_crop_msg"])

    col_left_arrow, col_slider, col_right_arrow = st.columns([1, 16, 1])

    with col_left_arrow:
        st.write("")
        st.write("")
        if st.button("◀", use_container_width=True, help="Decrease crop by 1px"):
            st.session_state["crop_px"] = max(0, st.session_state["crop_px"] - 1)

    with col_right_arrow:
        st.write("")
        st.write("")
        if st.button("▶", use_container_width=True, help="Increase crop by 1px"):
            st.session_state["crop_px"] = min(crop_max, st.session_state["crop_px"] + 1)

    with col_slider:
        st.slider(
            "Symmetric crop (px) – trims right of LEFT and left of RIGHT",
            min_value=0,
            max_value=crop_max,
            key="crop_px",
            help=(
                "The 3DS cameras are physically offset, so the left and right images don't quite line up. "
                "This crops the inner edge of each image by the same number of pixels — trimming the right "
                "side of the left view and the left side of the right view — so the remaining content overlaps correctly. "
                "Use 'Minimise Diff Value' to find the best value automatically, or drag until the overlay looks sharp."
            ),
        )

    crop_px = st.session_state["crop_px"]

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
        20, 400, 100, step=10,
        help=(
            "How long each frame is displayed, in milliseconds. "
            "Lower values speed up the overall animation; higher values slow it down. "
            "This applies equally to static frames and crossfade frames."
        ),
    )
    crossfade_steps = st.slider(
        "Crossfade steps",
        0, 10, 3,
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
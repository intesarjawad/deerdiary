/**
 * Relights the camera's frame from its depth map: the infrared flash each burst fires, and a hand
 * lamp that follows the pointer. The frame is a flat image; the depth map gives every pixel a height,
 * its slope gives the normal the light shades, and a march through the map toward the light finds
 * what casts a shadow. The prints are registered with the frame, so they take the same light.
 */

const VERTEX = `#version 300 es
in vec2 corner;
out vec2 vUv;
void main() {
  vUv = vec2(corner.x * 0.5 + 0.5, 0.5 - corner.y * 0.5);
  gl_Position = vec4(corner, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;

uniform sampler2D uMaster;
uniform sampler2D uDepth;
uniform sampler2D uCrops;
uniform vec2 uDepthTexel;
uniform vec2 uMasterTexel;
uniform float uAspect;
uniform vec4 uFlash;
uniform vec4 uTorch;
uniform vec2 uAim;
uniform float uAmbient;
uniform vec4 uActiveRect;
uniform float uActive;
uniform float uBloom;
uniform float uDay;
uniform float uSeed;

const float RELIEF = 0.16;
const float DETAIL = 0.55;
// Past this the slope is a cut-out edge in the depth map, not ground; steeper reads as a chrome rim.
const float MAX_SLOPE = 1.6;
const float STRIP = 0.03;
// The camera prints its maker's mark along the bottom edge; that strip is the camera's, not the place's.
const float BOTTOM_STRIP = 0.025;
const int SHADOW_STEPS = 28;
// How wide the infrared beam is, in frame heights.
const float BEAM = 0.13;
const float FLASH_GAIN = 16.0;
// The camera exposes for the animal: its print never takes more light than this, where the
// ground around it in the hot centre burns out.
const float FRONT_EXPOSURE = 1.0;
// How much of the frame's depth range the daylight sweep spreads over as it travels away from the lens.
const float SWEEP = 0.35;

float depthAt(vec2 uv) { return texture(uDepth, uv).r; }
float lum(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

vec3 surfaceNormal(vec2 uv) {
  vec2 dx = vec2(uDepthTexel.x * 1.5, 0.0);
  vec2 dy = vec2(0.0, uDepthTexel.y * 1.5);
  vec2 slope = vec2(depthAt(uv + dx) - depthAt(uv - dx), depthAt(uv + dy) - depthAt(uv - dy))
    * RELIEF / (2.0 * vec2(dx.x * uAspect, dy.y));
  slope /= max(1.0, length(slope) / MAX_SLOPE);
  // The photo's own brightness tilts the normal too: a dark groove reads as one under a moving light.
  vec2 mx = vec2(uMasterTexel.x, 0.0);
  vec2 my = vec2(0.0, uMasterTexel.y);
  vec2 detail = vec2(
    lum(texture(uMaster, uv + mx).rgb) - lum(texture(uMaster, uv - mx).rgb),
    lum(texture(uMaster, uv + my).rgb) - lum(texture(uMaster, uv - my).rgb)
  ) * DETAIL;
  return normalize(vec3(-slope - detail, 1.0));
}

// 1 where the light arrives, 0 where something nearer the light stands in its way.
float lit(vec3 p, vec3 light) {
  vec3 toLight = light - p;
  if (toLight.z <= 0.0) return 1.0;
  float reach = min(1.0, (RELIEF - p.z) / toLight.z);
  float occlusion = 0.0;
  for (int i = 1; i <= SHADOW_STEPS; i++) {
    float travel = float(i) / float(SHADOW_STEPS) * reach;
    vec3 q = p + toLight * travel;
    vec2 at = vec2(q.x / uAspect, q.y);
    if (at.x < 0.0 || at.x > 1.0 || at.y < STRIP || at.y > 1.0) break;
    float softness = 0.003 * (1.0 + travel * 24.0);
    occlusion = max(occlusion, clamp((depthAt(at) * RELIEF - q.z) / softness, 0.0, 1.0));
  }
  return 1.0 - occlusion;
}

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233)) + uSeed) * 43758.5453);
}

void main() {
  vec2 uv = vUv;
  if (uv.y < STRIP || uv.y > 1.0 - BOTTOM_STRIP) { outColor = vec4(0.0, 0.0, 0.0, 1.0); return; }

  vec4 crop = texture(uCrops, uv);
  vec3 albedo = mix(texture(uMaster, uv).rgb, crop.rgb, crop.a);
  // Infrared returns leaves brighter than the eye sees them; the flash frame is monochrome.
  float ir = lum(albedo) + 0.35 * max(albedo.g - 0.5 * (albedo.r + albedo.b), 0.0);
  float depth = depthAt(uv);
  vec3 p = vec3(uv.x * uAspect, uv.y, depth * RELIEF);
  vec3 n = surfaceNormal(uv);

  vec2 r = (uv - uAim) * vec2(uAspect, 1.0);
  float beam = exp(-dot(r, r) / (2.0 * BEAM * BEAM));
  float flash = 0.0;
  if (uFlash.w > 0.002) {
    vec3 l = uFlash.xyz - p;
    // The map is inverse depth, so the light that reaches a point goes with its square.
    float falloff = depth * depth;
    flash = uFlash.w * FLASH_GAIN * beam * falloff * max(dot(n, normalize(l)), 0.0) * lit(p, uFlash.xyz);
  }

  float torch = 0.0;
  if (uTorch.w > 0.002) {
    vec3 l = uTorch.xyz - p;
    float d = length(l);
    float cone = smoothstep(0.62, 0.0, length((uv - uTorch.xy / vec2(uAspect, 1.0)) * vec2(uAspect, 1.0)));
    torch = uTorch.w * max(dot(n, l / d), 0.0) * cone / (0.35 + 9.0 * d * d) * lit(p, uTorch.xyz);
  }

  // Between flashes a print takes the same light as the ground, so only the animal's own shape shows.
  float level = uAmbient + flash;
  float inFront = float(all(greaterThanEqual(uv, uActiveRect.xy))
    && all(lessThanEqual(uv, uActiveRect.xy + uActiveRect.zw)));
  // The beam is aimed at the animal, so it stands in the brightest part of the light, then fades.
  // Only the solid animal takes the extra light; ground in the matte's soft edge would show as a halo.
  level += inFront * smoothstep(0.6, 1.0, crop.a) * uActive * 0.3 * beam * (1.0 + 0.8 * uBloom);
  level = mix(level, min(level, FRONT_EXPOSURE), inFront * crop.a);
  vec3 lamp = albedo * torch * 2.2 * vec3(1.0, 0.93, 0.82);
  vec3 night = 1.0 - exp(-max(vec3(ir) * vec3(0.9, 0.96, 1.0) * level + lamp, 0.0) * 2.4);
  // In daylight the prints show as they were taken, so the photo passes through untouched.
  vec3 daylight = min(albedo + lamp * 0.5, 1.0);
  // Daylight arrives nearest the lens first and sweeps out to the far bank.
  float day = clamp((uDay * (1.0 + SWEEP) - (1.0 - depth)) / SWEEP, 0.0, 1.0);
  vec3 mapped = pow(mix(night, daylight, day), vec3(1.0 / 2.2));
  // Sensor noise, strongest where the frame is darkest, as on a real night exposure.
  mapped += (hash(uv * 911.0) - 0.5) * 0.04 * (1.0 - mapped);
  outColor = vec4(mapped, 1.0);
}`;

export type Light = { x: number; y: number; z: number; power: number };

export type RelightFrame = {
  flash: Light;
  torch: Light;
  /** Where the flash's beam is centred, in frame fractions. */
  aim: readonly [number, number];
  /** Light on the whole frame between flashes: the faint still the year starts from. */
  ambient: number;
  /** The visit the eye should land on: [x, y, width, height] in frame fractions. */
  activeRect: readonly [number, number, number, number];
  active: number;
  bloom: number;
  /** 0 while the year plays at night, 1 once the finished joiner shows in daylight colour. */
  day: number;
};

export type Relight = {
  draw(frame: RelightFrame): void;
  setCrops(layer: TexImageSource): void;
  resize(): void;
  dispose(): void;
};

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('WebGL could not create a shader.');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(shader) ?? 'Shader failed to compile.');
  }
  return shader;
}

function texture(gl: WebGL2RenderingContext, unit: number): WebGLTexture {
  const handle = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, handle);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return handle;
}

/** The depth PNG stores each value in 16 bits: red the high byte, green the low byte. */
export function unpackDepth(rgba: Uint8ClampedArray): Float32Array {
  const values = new Float32Array(rgba.length / 4);
  for (let i = 0; i < values.length; i++) {
    values[i] = ((rgba[i * 4] ?? 0) * 256 + (rgba[i * 4 + 1] ?? 0)) / 65535;
  }
  return values;
}

export function depthPixels(image: HTMLImageElement): Float32Array {
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
  if (!context) throw new Error('No 2D context to read the depth map.');
  context.drawImage(image, 0, 0);
  return unpackDepth(context.getImageData(0, 0, canvas.width, canvas.height).data);
}

/** Returns null when this browser has no WebGL2, so the caller keeps the still frame. */
export function createRelight(
  canvas: HTMLCanvasElement,
  master: HTMLImageElement,
  depth: HTMLImageElement,
  maxPixelRatio: number,
): Relight | null {
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
  if (!gl) return null;
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) ?? 'Shader program failed to link.');
  }
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const corner = gl.getAttribLocation(program, 'corner');
  gl.enableVertexAttribArray(corner);
  gl.vertexAttribPointer(corner, 2, gl.FLOAT, false, 0, 0);

  const u = (name: string) => gl.getUniformLocation(program, name);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);

  texture(gl, 0);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, master);
  texture(gl, 1);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.R16F,
    depth.naturalWidth,
    depth.naturalHeight,
    0,
    gl.RED,
    gl.FLOAT,
    depthPixels(depth),
  );
  const crops = texture(gl, 2);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));

  gl.uniform1i(u('uMaster'), 0);
  gl.uniform1i(u('uDepth'), 1);
  gl.uniform1i(u('uCrops'), 2);
  gl.uniform2f(u('uDepthTexel'), 1 / depth.naturalWidth, 1 / depth.naturalHeight);
  gl.uniform2f(u('uMasterTexel'), 1 / master.naturalWidth, 1 / master.naturalHeight);
  const aspect = master.naturalWidth / master.naturalHeight;
  gl.uniform1f(u('uAspect'), aspect);
  const flash = u('uFlash');
  const torch = u('uTorch');
  const aim = u('uAim');
  const ambient = u('uAmbient');
  const activeRect = u('uActiveRect');
  const active = u('uActive');
  const bloom = u('uBloom');
  const day = u('uDay');
  const seed = u('uSeed');

  const resize = () => {
    const ratio = Math.min(window.devicePixelRatio || 1, maxPixelRatio);
    const width = Math.round(canvas.clientWidth * ratio);
    const height = Math.round(canvas.clientHeight * ratio);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    gl.viewport(0, 0, width, height);
  };
  resize();

  return {
    draw(frame) {
      gl.uniform4f(flash, frame.flash.x * aspect, frame.flash.y, frame.flash.z, frame.flash.power);
      gl.uniform4f(torch, frame.torch.x * aspect, frame.torch.y, frame.torch.z, frame.torch.power);
      gl.uniform2f(aim, ...frame.aim);
      gl.uniform1f(ambient, frame.ambient);
      gl.uniform4f(activeRect, ...frame.activeRect);
      gl.uniform1f(active, frame.active);
      gl.uniform1f(bloom, frame.bloom);
      gl.uniform1f(day, frame.day);
      gl.uniform1f(seed, (performance.now() % 1000) / 100);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    setCrops(layer) {
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, crops);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, layer);
    },
    resize,
    dispose() {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}

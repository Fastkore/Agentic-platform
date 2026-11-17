import { useEffect, useRef, useState } from 'react';
import {
  Box3, Color, DirectionalLight, Group, HemisphereLight, LoadingManager, Mesh, MeshStandardMaterial,
  PerspectiveCamera, Scene, Sphere, Texture, WebGLRenderer, type BufferGeometry, type Material, type Object3D,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import type { PreviewModelFormat } from '../shared/chat-attachments';

function stlMesh(bytes: ArrayBuffer) {
  const header = new DataView(bytes);
  const binary = bytes.byteLength >= 84 && 84 + header.getUint32(80, true) * 50 === bytes.byteLength;
  const content = binary ? bytes : new TextDecoder().decode(bytes);
  if (typeof content === 'string' && !/^\s*solid(?:\s|$)/i.test(content)) throw new Error('Invalid STL');
  const geometry = new STLLoader().parse(content);
  return new Mesh(geometry, new MeshStandardMaterial({ color: 0x96bcf5, vertexColors: geometry.hasAttribute('color') }));
}

async function loadModel(format: PreviewModelFormat, bytes: ArrayBuffer) {
  if (format === 'stl') {
    const mesh = stlMesh(bytes);
    return { scene: mesh, resources: [mesh] };
  }
  const header = new DataView(bytes);
  if (header.byteLength < 20 || header.getUint32(0, true) !== 0x46546c67 ||
    header.getUint32(4, true) !== 2 || header.getUint32(8, true) !== header.byteLength) throw new Error('Invalid GLB');
  const manager = new LoadingManager();
  manager.setURLModifier(url => {
    if (/^(?:blob:|data:)/i.test(url)) return url;
    throw new Error('External GLB resources are unavailable');
  });
  const model = await new GLTFLoader(manager).parseAsync(bytes, '');
  return { scene: model.scene, resources: model.scenes };
}

function disposeModel(roots: Object3D[]) {
  const geometries = new Set<BufferGeometry>(), materials = new Set<Material>(), textures = new Set<Texture>();
  for (const root of roots) root.traverse(object => {
    const mesh = object as Mesh;
    if (mesh.geometry) geometries.add(mesh.geometry);
    if (Array.isArray(mesh.material)) mesh.material.forEach(item => materials.add(item));
    else if (mesh.material) materials.add(mesh.material);
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) {
    for (const value of Object.values(material)) if (value instanceof Texture) textures.add(value);
    material.dispose();
  }
  const bitmaps = new Set<ImageBitmap>();
  for (const texture of textures) {
    if (typeof ImageBitmap !== 'undefined' && texture.source.data instanceof ImageBitmap) bitmaps.add(texture.source.data);
    texture.dispose();
  }
  for (const bitmap of bitmaps) bitmap.close();
}

export function ChatModelPreview({ url, format, request }: {
  url: string;
  format: PreviewModelFormat;
  request: (url: string, init: RequestInit, responseType: 'blob') => Promise<Blob>;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const reset = useRef<() => void>(undefined);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');

  useEffect(() => {
    const surface = canvas.current!;
    const viewport = surface.parentElement!;
    const controller = new AbortController();
    let renderer: WebGLRenderer | undefined, controls: OrbitControls | undefined, resizeObserver: ResizeObserver | undefined;
    let resources: Object3D[] = [];

    const dispose = () => {
      resizeObserver?.disconnect();
      controls?.dispose();
      renderer?.dispose();
      renderer?.forceContextLoss();
      disposeModel(resources);
      resizeObserver = undefined;
      controls = undefined;
      renderer = undefined;
      resources = [];
      reset.current = undefined;
    };

    async function open() {
      const file = await request(url, { signal: controller.signal }, 'blob');
      const bytes = await file.arrayBuffer();
      controller.signal.throwIfAborted();
      const model = await loadModel(format, bytes);
      if (controller.signal.aborted) { disposeModel(model.resources); return; }
      resources = model.resources;
      const sphere = new Box3().setFromObject(model.scene).getBoundingSphere(new Sphere());
      if (!Number.isFinite(sphere.radius) || sphere.radius <= 0) throw new Error('Invalid model geometry');

      const scene = new Scene();
      scene.background = new Color(0x17202d);
      const framed = new Group();
      framed.scale.setScalar(1 / sphere.radius);
      framed.position.copy(sphere.center).multiplyScalar(-1 / sphere.radius);
      framed.add(model.scene);
      const light = new DirectionalLight(0xffffff, 2.3);
      light.position.set(3, 4, 2);
      scene.add(framed, new HemisphereLight(0xf5f9ff, 0x49546b, 2), light);

      const camera = new PerspectiveCamera(42, 1, 0.02, 100);
      camera.position.set(2.7, 1.9, 2.7);
      const output = renderer = new WebGLRenderer({ canvas: surface, antialias: true });
      output.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      const orbit = controls = new OrbitControls(camera, surface);
      orbit.minDistance = 1.2;
      orbit.maxDistance = 16;
      orbit.update();
      orbit.saveState();
      orbit.listenToKeyEvents(surface);
      reset.current = () => orbit.reset();
      const render = () => output.render(scene, camera);
      orbit.addEventListener('change', render);
      const resize = () => {
        const { clientWidth, clientHeight } = viewport;
        if (!clientWidth || !clientHeight) return;
        output.setSize(clientWidth, clientHeight, false);
        camera.aspect = clientWidth / clientHeight;
        camera.updateProjectionMatrix();
        render();
      };
      resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(viewport);
      resize();
      setState('ready');
    }

    void open().catch(() => {
      if (controller.signal.aborted) return;
      dispose();
      setState('error');
    });
    return () => { controller.abort(); dispose(); };
  }, [format, request, url]);

  return <>
    <div className="chat-model-viewport">
      <canvas ref={canvas} tabIndex={state === 'ready' ? 0 : -1} aria-label="Интерактивная 3D-модель" />
      {state === 'loading' && <p className="chat-model-status" role="status">Загружаем 3D-модель…</p>}
      {state === 'error' && <p className="chat-model-status" role="alert">Браузер не смог открыть эту 3D-модель. Файл можно скачать в чате.</p>}
    </div>
    {state === 'ready' && <div className="chat-model-controls">
      <span>Перетащите для вращения, прокрутите для приближения</span>
      <button type="button" className="secondary" onClick={() => reset.current?.()}>Сбросить вид</button>
    </div>}
  </>;
}

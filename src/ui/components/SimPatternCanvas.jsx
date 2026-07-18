import { onCleanup, onMount } from 'solid-js';
import 'pixi.js/browser';
import * as PIXI from 'pixi.js';
import { clothingStore } from '../../vendor/vibe-human/features/clothing/state/clothingStore.ts';
import { setHoveredEntity } from '../../vendor/vibe-human/features/clothing/state/clothingActions.ts';
import { PatternRenderer } from '../../vendor/vibe-human/features/clothing/pixi/PatternRenderer.ts';
import { OverlayRenderer } from '../../vendor/vibe-human/features/clothing/pixi/OverlayRenderer.ts';
import { pickAt } from '../../vendor/vibe-human/features/clothing/pixi/PatternPicker.ts';
import { CanvasController } from '../../vendor/vibe-human/features/clothing/pixi/interaction/CanvasController.ts';
import { screenToWorld } from '../../vendor/vibe-human/features/clothing/pixi/interaction/Camera.ts';
import { COLORS, drawGrid } from '../../vendor/vibe-human/features/clothing/pixi/pixiUtils.ts';

/** Solid owner for the vendored framework-free Pixi pattern renderer/tools. */
export function SimPatternCanvas(props) {
  let container;
  let cleanup = () => {};

  onMount(() => {
    let mounted = true;
    let controller = null;
    let resizeObserver = null;
    let hoverCleanup = null;
    const app = new PIXI.Application();

    const resize = () => {
      if (!mounted || !app.renderer) return;
      app.renderer.resize(
        Math.max(1, Math.floor(container.clientWidth)),
        Math.max(1, Math.floor(container.clientHeight)),
      );
    };

    app.init({
      width: Math.max(1, container.clientWidth),
      height: Math.max(1, container.clientHeight),
      background: COLORS.background,
      backgroundColor: COLORS.background,
      antialias: true,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      autoDensity: true,
      manageImports: false,
      preference: 'webgl',
    }).then(() => {
      if (!mounted) {
        app.destroy();
        return;
      }
      const canvas = app.canvas;
      canvas.dataset.simPatternCanvas = 'true';
      canvas.setAttribute('aria-label', 'Garment pattern editor');
      canvas.style.cssText = 'display:block;width:100%;height:100%;touch-action:none';
      container.appendChild(canvas);

      const world = new PIXI.Container();
      const grid = new PIXI.Graphics();
      app.stage.addChild(world);
      world.addChild(grid);
      const renderer = new PatternRenderer(world);
      const overlay = new OverlayRenderer(world);
      controller = new CanvasController(canvas);

      const onHover = (event) => {
        if (event.pointerType === 'touch') return;
        const rect = canvas.getBoundingClientRect();
        const screen = { x: event.clientX - rect.left, y: event.clientY - rect.top };
        const point = screenToWorld(screen, canvas.clientWidth, canvas.clientHeight);
        const pick = pickAt(clothingStore.garment, point, clothingStore.viewport2D.zoom);
        if (!pick) setHoveredEntity(null, null);
        else if (pick.type === 'point') setHoveredEntity(pick.pointId, 'point');
        else if (pick.type === 'edge') setHoveredEntity(pick.edgeId, 'edge');
        else if (pick.type === 'pattern') setHoveredEntity(pick.patternId, 'pattern');
      };
      canvas.addEventListener('pointermove', onHover);
      hoverCleanup = () => canvas.removeEventListener('pointermove', onHover);

      app.ticker.add(() => {
        const { garment, viewport2D, previewOptions, selectedPatternIds } = clothingStore;
        const width = canvas.clientWidth || app.renderer.width / (window.devicePixelRatio || 1);
        const height = canvas.clientHeight || app.renderer.height / (window.devicePixelRatio || 1);
        if (width <= 1 || height <= 1) return;
        world.x = -viewport2D.panX * viewport2D.zoom + width / 2;
        world.y = -viewport2D.panY * viewport2D.zoom + height / 2;
        world.scale.set(viewport2D.zoom);
        const worldWidth = width / viewport2D.zoom;
        const worldHeight = height / viewport2D.zoom;
        const left = viewport2D.panX - worldWidth / 2;
        const top = viewport2D.panY - worldHeight / 2;
        drawGrid(grid, left, top, left + worldWidth, top + worldHeight, 50);
        renderer.render(garment, viewport2D.hoveredEntityId, previewOptions.showSeams, true, selectedPatternIds);
        overlay.render(viewport2D.zoom);
      });

      resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(container);
      requestAnimationFrame(resize);
      props.onReady?.(canvas);
    }).catch((error) => {
      console.error('Failed to initialize garment pattern canvas.', error);
      props.onError?.(error);
    });

    cleanup = () => {
      mounted = false;
      hoverCleanup?.();
      controller?.destroy();
      resizeObserver?.disconnect();
      try { app.destroy(true, { children: true }); } catch {}
    };
  });

  onCleanup(() => cleanup());

  return <div ref={container} class="sim-pattern-canvas" data-testid="sim-pattern-editor" />;
}

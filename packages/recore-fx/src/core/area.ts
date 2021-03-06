import { Fragment, ReactNode, Component, ReactType, createElement } from 'react';
import { nextId } from '../obx/utils';
import { Reaction } from '../obx/reaction';
import { nextTick, getReaction, computed } from '../obx';
import { hasOwnProperty } from '../utils';
import { create } from '../lib';
import X, { DisplayError, isDisplayError } from '../lib/x';
import View from './view';
import { splitPath } from '../utils/split-path';

export interface AreaConfig {
  id?: string;
  virtual?: boolean;
  item?: boolean;
}

export interface CursorData {
  $id: string;
  $each: any;
  [key: string]: any;
}

export interface Scope {
  readonly $top: Scope;
  readonly $super?: Scope;
  [property: string]: any;
}

const EMPTY_NODE = '';

function isValidArrayIndex(val: any, limit: number = -1): boolean {
  const n = parseFloat(String(val));
  return n >= 0 && Math.floor(n) === n && isFinite(val) && (limit < 0 || n < limit);
}

export default class Area {
  readonly id: string;
  readonly virtual: boolean;
  readonly inExpression: boolean;
  private areasMap: { [name: string]: Area } = {};
  private areas: Area[] = [];
  private areaInstance?: Component;
  private reaction?: Reaction;
  private isItem?: boolean;

  constructor(public scope: Scope, { id, virtual, item }: AreaConfig, private parent?: Area) {
    this.inExpression = !id;
    this.id = id || nextId();
    this.virtual = virtual === true;
    this.isItem = item;
  }

  get path(): null | string {
    if (!this.parent) {
      if (this.id === 'root') {
        return '';
      }
      return null;
    }

    let pKey = this.parent.path;
    if (pKey === null) {
      return null;
    }

    if (pKey !== '') {
      pKey += '/';
    }
    const key = this.isItem ? '*' : this.id;
    return pKey + key;
  }

  get(path: string): Area | Area[] | null {
    const pathArray = splitPath(path);

    if (!pathArray) {
      return null;
    }

    const entry = pathArray[1];
    const nestPath = pathArray[2];

    if (!entry) {
      return this.get(nestPath);
    }

    let ret: any;
    if (entry === '*') {
      ret = this.areas;
    } else if (isValidArrayIndex(entry, this.areas.length)) {
      ret = this.areas[entry as any];
    } else {
      ret = this.areasMap[entry];
    }

    if (!nestPath || ret == null) {
      return ret;
    }

    return Array.isArray(ret) ? ret.map(r => r.get(nestPath)) : ret.get(nestPath);
  }

  getView(id: string, useRef: boolean = false): View | any | null {
    const view = this.views[id] || null;
    if (!view || !useRef) {
      return view;
    }
    return view.$ref || view;
  }

  render(getChildren: (area: Area) => ReactNode[]) {
    return renderArea(this, () => create(Fragment, null, getChildren(this)));
  }

  flow(...flows: Array<[true | ((area: Area) => any), (area: Area) => ReactNode]>): ReactNode {
    const l = flows.length;
    for (let i = 0; i < l; i++) {
      const [test, render] = flows[i];
      const result = test === true || test(this);
      if (isDisplayError(result)) {
        return result;
      }
      if (result) {
        return render(this);
      }
    }
    return EMPTY_NODE;
  }

  loop(
    id: string | undefined,
    getLoopData: (area: Area) => any,
    delegate: () => ReactNode,
    virtual: boolean = false,
  ): ReactNode {
    return this.area(
      id,
      area => {
        const data = getLoopData(area);
        if (isDisplayError(data)) {
          return data;
        }
        return loop(data, delegate.bind(null, area));
      },
      virtual,
    );
  }

  private views: { [id: string]: View } = {};
  view(
    xid: string,
    getProps?: (scope: object, area: Area) => any[],
    getChildren?: (area: Area) => ReactNode[],
    getSlots?: (area: Area) => { [slot: string]: ReactNode },
  ): ReactNode {
    const m = RE_XID.exec(xid);
    if (!m) {
      return EMPTY_NODE;
    }
    const [_, areaid, tagName, id] = m;
    if (areaid) {
      return this.area(areaid, area => area.view(`${tagName}#${id}`, getProps, getChildren, getSlots));
    }

    const component = this.scope.$registry.get(tagName);
    let view: View;
    if (id && hasOwnProperty(this.views, id)) {
      view = this.views[id]!;
    } else {
      view = new View(this, id, component, getProps, getSlots);
      if (id) {
        this.views[id] = view;
      }
    }

    return tryRender(() => {
      const props = { ...view.props };
      return create(component, props, getChildren ? getChildren(this) : undefined);
    });
  }

  create(component: ReactType, props: any, children?: any) {
    return create(component, props, children);
  }

  router(id: string, getProps?: (scope: object) => any[]) {
    return this.scope.__routerView(getProps ? getProps(this.scope) : undefined);
  }

  private exprs: { [id: string]: { readonly value: any } } = {};
  /**
   * TODO:will unsupport id=undefined
   */
  expr(id: string | undefined, getExpr: (scope: object, area: Area) => any): any {
    const scope = this.scope;
    const area = this;
    if (!id) {
      return tryRender(() => getExpr(scope, area));
    }
    if (hasOwnProperty(this.exprs, id)) {
      return this.exprs[id].value;
    }

    // eg. ($scope) => $scope._('abc')
    const e = computed(() => tryRender(() => getExpr(scope, area)));
    this.exprs[id] = e;
    return e.value;
  }

  /**
   * TODO:will unsupport id=undefined
   */
  area(id: string | undefined, render: (area: Area) => ReactNode, virtual: boolean = false) {
    return renderArea(this.child({ id, virtual }), render);
  }

  fork(data: CursorData, render: (area: Area) => ReactNode) {
    return tryRender(() => renderArea(this.produce(data), render));
  }

  // will support @1.6
  tpl(id: string, render: (area: Area) => ReactNode) {
    /*
    const area = this;
    function template(props: any) {
      return render(area.temp({ props }));
    }
    this.scope._tpls[id] = template;
    */
  }

  /*
  private temp(data: object) {
    const scope = this.scope._derive(data);
    return new Area(
      scope,
      { virtual: true, },
      this,
    );
  }*/

  private child(config: AreaConfig): Area {
    if (config.id === this.id) {
      return this;
    }

    if (!config.id) {
      return new Area(this.scope, config, this);
    }

    if (hasOwnProperty(this.areasMap, config.id)) {
      return this.areasMap[config.id]!;
    }

    const area = new Area(this.scope, config, this);

    this.areas.push(area);
    this.areasMap[area.id] = area;

    return area;
  }

  willSleep: boolean = false;
  private dispose() {
    let i = this.areas.length;
    while (i-- > 0) {
      const area = this.areas[i];
      if (area.willSleep) {
        area.purge();
        delete this.areasMap[area.id];
        this.areas.splice(i, 1);
      }
    }
  }

  private marked: boolean = false;
  private produce(data: CursorData) {
    const id = data.$id;
    if (!this.marked) {
      this.marked = true;
      this.areas.forEach(item => {
        item.willSleep = true;
      });
      nextTick(() => {
        this.marked = false;
        this.dispose();
      });
    }

    let area: Area;
    if (hasOwnProperty(this.areasMap, id)) {
      area = this.areasMap[id]!;
      if (area.scope.$each === data.$each) {
        area.willSleep = false;
        return area;
      }
    }

    const scope = this.scope._derive(data);
    area = new Area(
      scope,
      {
        id,
        virtual: this.virtual,
        item: true,
      },
      this,
    );
    this.areas.push(area);
    this.areasMap[id] = area;

    return area;
  }

  private purged = false;
  purge() {
    if (this.purged) {
      return;
    }
    this.purged = true;
    if (this.reaction) {
      this.reaction.sleep();
    }
    this.areas.forEach(area => area.purge());
    this.areas = [];
    this.areasMap = {};
  }

  connect(areaInstance?: Component) {
    this.areaInstance = areaInstance;
    this.reaction = areaInstance ? getReaction(areaInstance) : undefined;
  }

  runImmediately() {
    if (this.virtual) {
      if (this.parent) {
        this.parent.runImmediately();
      }
      return;
    }
    if (this.reaction) {
      this.reaction.runReaction();
    }
  }

  forceUpdate() {
    if (this.areaInstance) {
      this.areaInstance.forceUpdate();
    }
  }
}

const RE_XID = /^(?:@([\w\-]+):)?([\w\.]+)(?:#([\w\-]+))?/;

function tryRender(render: () => any): any {
  try {
    return render();
  } catch (e) {
    return create(DisplayError, { error: e });
  }
}

function iterMap(data: Map<any, any>, fn: (item: any, key: any) => void) {
  data.forEach(fn);
}

function iterSet(data: Set<any>, fn: (item: any, key: any) => void) {
  let index = 0;
  data.forEach(item => {
    fn(item, index++);
  });
}

function loop(data: any, delegate: (key: string | number, val: any) => any) {
  if (Array.isArray(data)) {
    return data.map((item, index) => delegate(index, item));
  }

  if (typeof data === 'number') {
    const ret = new Array(data);
    for (let i = 0; i < data; i++) {
      ret[i] = delegate(i, i + 1);
    }
    return ret;
  }

  if (data) {
    if (data instanceof Set || data instanceof Map) {
      const frags: any[] = [];

      const fn = (item: any, key: any): void => {
        frags.push(delegate(key, item));
      };
      data instanceof Map ? iterMap(data, fn) : iterSet(data, fn);

      return frags;
    }

    return Object.keys(data).map(key => {
      return delegate(key, (data as any)[key]);
    });
  }

  return null;
}

function renderArea(area: any, render: (area: any) => ReactNode) {
  if (area.virtual) {
    return render(area);
  }

  return createElement(X, {
    key: area.id,
    area,
    render,
  });
}

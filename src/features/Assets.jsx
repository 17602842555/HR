import React, { useState } from "react";
import { AssetQr } from "../components/AssetQr.jsx";
import { DataTable, MetricCard, Panel, StatusPill } from "../components/Primitives.jsx";

export function Assets({ actions, onOpenAsset, state }) {
  const [selected, setSelected] = useState(state.assets[0]?.id || "");
  const current = state.assets.find((item) => item.id === selected) || state.assets[0];
  const currentEvents = state.assetEvents.filter((item) => item.assetId === current?.id).slice(0, 8);
  const columns = [
    { key: "id", label: "资产编号" },
    { key: "name", label: "资产名称" },
    { key: "category", label: "类别" },
    { key: "owner", label: "使用人/区域" },
    { key: "location", label: "位置" },
    { key: "status", label: "状态", render: (row) => <StatusPill value={row.status} /> },
    { key: "action", label: "操作", render: (row) => <button type="button" onClick={() => setSelected(row.id)}>查看</button> }
  ];

  return (
    <div className="module-layout">
      <section className="module-title">
        <div>
          <h1>行政资产</h1>
          <p>设备台账、资产二维码、借用归还、维修与盘点闭环。</p>
        </div>
        <button className="primary" type="button" onClick={onOpenAsset}>录入资产</button>
      </section>
      <section className="kpi-strip">
        <MetricCard label="资产总数" value={`${state.assets.length} 件`} />
        <MetricCard label="使用中" tone="green" value={`${state.assets.filter((item) => item.status.includes("用") || item.status.includes("借")).length} 件`} />
        <MetricCard label="维修中" tone="red" value={`${state.assets.filter((item) => item.status.includes("维修")).length} 件`} />
        <MetricCard label="空闲设备" value={`${state.assets.filter((item) => item.status === "空闲").length} 件`} />
      </section>
      <div className="split-view">
        <Panel title="资产台账" actions={<button type="button" onClick={() => actions.exportAssets({ scope: "资产台账" })}>导出台账</button>}>
          <DataTable columns={columns} rows={state.assets} />
        </Panel>
        <Panel title="资产二维码与流转">
          {current ? (
            <div className="asset-detail">
              <div>
                <AssetQr asset={current} />
                <span>二维码 V{current.qrVersion}</span>
              </div>
              <dl>
                <div><dt>资产编号</dt><dd>{current.id}</dd></div>
                <div><dt>资产名称</dt><dd>{current.name}</dd></div>
                <div><dt>使用人</dt><dd>{current.owner}</dd></div>
                <div><dt>位置</dt><dd>{current.location}</dd></div>
                <div><dt>状态</dt><dd><StatusPill value={current.status} /></dd></div>
              </dl>
              <div className="action-row">
                <button type="button" onClick={() => actions.updateAsset(current.id, "借用中")}>借用</button>
                <button type="button" onClick={() => actions.updateAsset(current.id, "空闲")}>归还</button>
                <button type="button" onClick={() => actions.updateAsset(current.id, "维修中")}>维修</button>
                <button type="button" onClick={() => actions.inventoryAsset(current.id, "正常")}>盘点</button>
                <button type="button" onClick={() => actions.replaceQr(current.id)}>更换二维码</button>
              </div>
              <div className="detail-subhead">资产履历</div>
              <ul className="timeline-list compact-list">
                {currentEvents.map((event) => (
                  <li key={event.id}>
                    <i />
                    <div><strong>{event.type}</strong><span>{event.content}</span><em>{event.operator} · {event.time}</em></div>
                  </li>
                ))}
                {currentEvents.length === 0 ? <li><span>暂无履历</span></li> : null}
              </ul>
            </div>
          ) : null}
        </Panel>
      </div>
    </div>
  );
}

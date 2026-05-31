import React from "react";
import { Bell, ChevronDown, Search, UserRound } from "lucide-react";
import { sideNav } from "../data/seed.js";
import { publicAsset } from "../utils/publicAsset.js";

export function AppShell({
  activeModule,
  children,
  currentUser,
  metrics,
  onNavigate,
  onSearchResultClick,
  query,
  searchResults = [],
  setQuery
}) {
  const organization = currentUser?.organization || "集团总部";
  const userName = currentUser?.name || "张三";
  const department = currentUser?.department || "行政部";
  const trimmedQuery = query.trim();

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <img src={publicAsset("assets/logo-mark.png")} alt="" />
          <strong>集团人事行政<br />OA</strong>
        </div>
        <nav className="side-nav" aria-label="主导航">
          {sideNav.map(({ id, label, icon: Icon }) => (
            <button className={id === activeModule ? "active" : ""} key={id} type="button" onClick={() => onNavigate(id)}>
              <Icon size={18} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
      </aside>
      <section className="workspace">
        <header className="topbar">
          <div className="global-search-wrap">
            <label className="global-search">
              <Search size={17} />
              <input value={query} placeholder="搜索菜单、流程、文档、人员等" onChange={(event) => setQuery(event.target.value)} />
            </label>
            {trimmedQuery ? (
              <div className="global-search-results" aria-label="全局搜索结果">
                {searchResults.length ? searchResults.map((item) => (
                  <button key={item.id} type="button" onClick={() => onSearchResultClick?.(item)}>
                    <span className="search-result-type">{item.type}</span>
                    <span className="search-result-copy">
                      <strong>{item.title}</strong>
                      <em>{item.subtitle}</em>
                    </span>
                  </button>
                )) : (
                  <div className="search-empty">
                    <strong>未找到相关入口</strong>
                    <span>换一个关键词搜索菜单、流程、人员或资源。</span>
                  </div>
                )}
              </div>
            ) : null}
          </div>
          <div className="top-meta">
            <span>当前组织：<strong>{organization}</strong></span>
            <button className="notice" type="button" aria-label="通知">
              <Bell size={18} />
              {metrics.pendingApprovals ? <em>{metrics.pendingApprovals}</em> : null}
            </button>
            <button className="avatar" type="button" aria-label="个人中心"><UserRound size={18} /></button>
            <button className="user-button" type="button">{userName} · {department} <ChevronDown size={14} /></button>
          </div>
        </header>
        <main className="content">{children}</main>
      </section>
    </div>
  );
}

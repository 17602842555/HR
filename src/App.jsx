import React, { useMemo, useState } from "react";
import { LockKeyhole } from "lucide-react";
import { AppShell } from "./components/AppShell.jsx";
import { Modal } from "./components/Modal.jsx";
import { Analytics } from "./features/Analytics.jsx";
import { Approvals } from "./features/Approvals.jsx";
import { Assets } from "./features/Assets.jsx";
import { Attendance } from "./features/Attendance.jsx";
import { Audit } from "./features/Audit.jsx";
import { Finance } from "./features/Finance.jsx";
import { Home } from "./features/Home.jsx";
import { People } from "./features/People.jsx";
import { Resources } from "./features/Resources.jsx";
import { flowTemplates, formDefaults, templatesFromDefinitions } from "./data/seed.js";
import { useApiBackedOaSystem } from "./hooks/query/useApiBackedOaSystem.js";
import { buildGlobalSearchResults } from "./services/globalSearch.js";

function FieldInput({ field, onChange, value }) {
  if (field.type === "select") {
    return (
      <select value={value} onChange={(event) => onChange(field.id, event.target.value)}>
        {(field.options || []).map((option) => <option key={option}>{option}</option>)}
      </select>
    );
  }
  if (field.type === "textarea") {
    return <textarea value={value} onChange={(event) => onChange(field.id, event.target.value)} />;
  }
  return (
    <input
      type={field.type === "number" || field.type === "amount" ? "number" : field.type === "date" ? "date" : "text"}
      value={value}
      onChange={(event) => onChange(field.id, event.target.value)}
    />
  );
}

function FlowForm({ actions, departments, initialTemplate, onClose, workflowTemplates }) {
  const templateOptions = workflowTemplates?.length ? workflowTemplates : flowTemplates;
  const [templateId, setTemplateId] = useState(initialTemplate?.id || "expense");
  const template = templateOptions.find((item) => item.id === templateId) || templateOptions[0] || flowTemplates[0];
  const departmentOptions = departments.includes(template.department) ? departments : [template.department, ...departments];
  const [form, setForm] = useState({
    title: initialTemplate?.name || template.name,
    applicant: initialTemplate?.owner || "张三",
    department: initialTemplate?.department || template.department,
    reason: "用于当前业务流程审批，完成后自动归档并写入审计。",
    formData: formDefaults(template)
  });

  const submit = () => {
    actions.createApproval(template, form);
    onClose();
  };

  return (
    <div className="form-stack">
      <label>流程类型
        <select value={templateId} onChange={(event) => {
          const next = templateOptions.find((item) => item.id === event.target.value) || templateOptions[0] || flowTemplates[0];
          setTemplateId(next.id);
          setForm((current) => ({
            ...current,
            title: next.name,
            applicant: next.owner,
            department: next.department,
            formData: formDefaults(next)
          }));
        }}>
          {templateOptions.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>
      <label>申请标题<input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></label>
      <label>申请人<input value={form.applicant} onChange={(event) => setForm({ ...form, applicant: event.target.value })} /></label>
      <label>所属部门
        <select value={form.department} onChange={(event) => setForm({ ...form, department: event.target.value })}>
          {departmentOptions.map((department) => <option key={department}>{department}</option>)}
        </select>
      </label>
      <div className="form-section">
        <strong>表单控件</strong>
        <span>{template.condition} · {template.approvalMode}</span>
      </div>
      {template.fields.map((field) => (
        <label key={field.id}>{field.label}
          <FieldInput
            field={field}
            value={form.formData[field.id] || ""}
            onChange={(fieldId, value) => setForm((current) => ({
              ...current,
              formData: { ...current.formData, [fieldId]: value }
            }))}
          />
        </label>
      ))}
      <label>申请说明<textarea value={form.reason} onChange={(event) => setForm({ ...form, reason: event.target.value })} /></label>
      <div className="modal-actions">
        <button type="button" onClick={onClose}>取消</button>
        <button className="primary" type="button" onClick={submit}>提交申请</button>
      </div>
    </div>
  );
}

function AssetForm({ actions, onClose }) {
  const [form, setForm] = useState({
    name: "直播间备用补光灯",
    category: "直播设备",
    owner: "设备库",
    status: "空闲",
    location: "三楼设备库"
  });
  const submit = () => {
    actions.createAsset(form);
    onClose();
  };
  return (
    <div className="form-stack">
      <label>资产名称<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
      <label>资产类别
        <select value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })}>
          <option>直播设备</option>
          <option>办公电脑</option>
          <option>会议设备</option>
          <option>行政固定资产</option>
        </select>
      </label>
      <label>使用人/区域<input value={form.owner} onChange={(event) => setForm({ ...form, owner: event.target.value })} /></label>
      <label>状态<input value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value })} /></label>
      <label>存放位置<input value={form.location} onChange={(event) => setForm({ ...form, location: event.target.value })} /></label>
      <div className="modal-actions">
        <button type="button" onClick={onClose}>取消</button>
        <button className="primary" type="button" onClick={submit}>保存并生成二维码</button>
      </div>
    </div>
  );
}

function LoginScreen({ apiStatus, auth }) {
  const [form, setForm] = useState({
    tenantCode: "default",
    email: "admin@oa.local",
    password: "admin123456"
  });
  const [error, setError] = useState(apiStatus.error || "");

  const submit = async (event) => {
    event.preventDefault();
    setError("");
    const result = await auth.login(form);
    if (!result.ok) setError(result.error?.message || "登录失败");
  };

  return (
    <main className="login-page">
      <section className="login-panel">
        <div className="login-brand">
          <img src="/assets/logo-mark.png" alt="" />
          <div>
            <span>集团人事行政 OA</span>
            <strong>商业版后台登录</strong>
          </div>
        </div>
        <form className="login-form" onSubmit={submit}>
          <label>租户
            <input value={form.tenantCode} onChange={(event) => setForm({ ...form, tenantCode: event.target.value })} />
          </label>
          <label>邮箱
            <input value={form.email} autoComplete="username" onChange={(event) => setForm({ ...form, email: event.target.value })} />
          </label>
          <label>密码
            <input type="password" value={form.password} autoComplete="current-password" onChange={(event) => setForm({ ...form, password: event.target.value })} />
          </label>
          {error ? <p className="login-error">{error}</p> : <p className="login-hint">默认演示账号来自 seed，生产环境请替换初始密码和 JWT 密钥。</p>}
          <button className="primary" type="submit" disabled={auth.busy}>
            <LockKeyhole size={16} /> {auth.busy ? "登录中" : "登录系统"}
          </button>
        </form>
      </section>
    </main>
  );
}

function ApiRequiredScreen({ apiStatus }) {
  return (
    <main className="login-page">
      <section className="login-panel">
        <div className="login-brand">
          <img src="/assets/logo-mark.png" alt="" />
          <div>
            <span>集团人事行政 OA</span>
            <strong>后端服务不可用</strong>
          </div>
        </div>
        <div className="api-required-copy">
          <p>当前构建要求连接商业后端，已禁止使用本地演示数据。</p>
          <p>{apiStatus.error || "请检查 API 服务、PostgreSQL 数据库、Vite 代理和部署环境变量。"}</p>
          <code>npm run doctor:commercial</code>
        </div>
      </section>
    </main>
  );
}

function FirstLoginSetupScreen({ apiStatus, auth, currentUser }) {
  const [form, setForm] = useState({
    confirmPassword: "",
    currentPassword: "",
    email: currentUser?.email || "",
    name: currentUser?.name || "",
    newPassword: ""
  });
  const [error, setError] = useState(apiStatus.error || "");

  const submit = async (event) => {
    event.preventDefault();
    setError("");
    if (form.newPassword !== form.confirmPassword) {
      setError("两次输入的新密码不一致。");
      return;
    }
    const result = await auth.completeFirstLogin({
      currentPassword: form.currentPassword,
      email: form.email,
      name: form.name,
      newPassword: form.newPassword
    });
    if (!result.ok) setError(result.error?.message || "首次登录设置失败。");
  };

  return (
    <main className="login-page">
      <section className="login-panel">
        <div className="login-brand">
          <img src="/assets/logo-mark.png" alt="" />
          <div>
            <span>集团人事行政 OA</span>
            <strong>首次登录设置</strong>
          </div>
        </div>
        <form className="login-form" onSubmit={submit}>
          <label>登录账号
            <input autoComplete="username" type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} />
          </label>
          <label>姓名
            <input autoComplete="name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} />
          </label>
          <label>临时密码
            <input autoComplete="current-password" type="password" value={form.currentPassword} onChange={(event) => setForm({ ...form, currentPassword: event.target.value })} />
          </label>
          <label>新密码
            <input autoComplete="new-password" placeholder="至少 12 位，含字母和数字" type="password" value={form.newPassword} onChange={(event) => setForm({ ...form, newPassword: event.target.value })} />
          </label>
          <label>确认新密码
            <input autoComplete="new-password" type="password" value={form.confirmPassword} onChange={(event) => setForm({ ...form, confirmPassword: event.target.value })} />
          </label>
          {error ? <p className="login-error">{error}</p> : <p className="login-hint">完成后临时密码失效，后续使用新的登录账号和密码进入系统。</p>}
          <button className="primary" type="submit" disabled={auth.busy}>
            <LockKeyhole size={16} /> {auth.busy ? "保存中" : "完成设置"}
          </button>
          <button type="button" onClick={auth.logout}>退出登录</button>
        </form>
      </section>
    </main>
  );
}

function LeaveForm({ actions, onClose }) {
  const [form, setForm] = useState({ employee: "张三", type: "年假", dates: "2026-05-30 ~ 2026-05-31", days: 2 });
  const submit = () => {
    actions.createLeave(form);
    onClose();
  };
  return (
    <div className="form-stack">
      <label>员工<input value={form.employee} onChange={(event) => setForm({ ...form, employee: event.target.value })} /></label>
      <label>假勤类型
        <select value={form.type} onChange={(event) => setForm({ ...form, type: event.target.value })}>
          <option>年假</option>
          <option>病假</option>
          <option>事假</option>
          <option>调休</option>
        </select>
      </label>
      <label>日期<input value={form.dates} onChange={(event) => setForm({ ...form, dates: event.target.value })} /></label>
      <label>天数<input type="number" value={form.days} onChange={(event) => setForm({ ...form, days: Number(event.target.value) })} /></label>
      <div className="modal-actions">
        <button type="button" onClick={onClose}>取消</button>
        <button className="primary" type="button" onClick={submit}>提交假勤申请</button>
      </div>
    </div>
  );
}

function ChangePasswordForm({ auth, onClose }) {
  const [form, setForm] = useState({ currentPassword: "", newPassword: "", confirmPassword: "" });
  const [error, setError] = useState("");

  const submit = async (event) => {
    event.preventDefault();
    setError("");
    if (form.newPassword !== form.confirmPassword) {
      setError("两次输入的新密码不一致。");
      return;
    }
    const result = await auth.changePassword({
      currentPassword: form.currentPassword,
      newPassword: form.newPassword
    });
    if (!result.ok) {
      setError(result.error?.message || "密码修改失败。");
      return;
    }
    onClose();
  };

  return (
    <form className="form-stack" onSubmit={submit}>
      <label>当前密码
        <input
          autoComplete="current-password"
          type="password"
          value={form.currentPassword}
          onChange={(event) => setForm({ ...form, currentPassword: event.target.value })}
        />
      </label>
      <label>新密码
        <input
          autoComplete="new-password"
          placeholder="至少 12 位，含字母和数字"
          type="password"
          value={form.newPassword}
          onChange={(event) => setForm({ ...form, newPassword: event.target.value })}
        />
      </label>
      <label>确认新密码
        <input
          autoComplete="new-password"
          type="password"
          value={form.confirmPassword}
          onChange={(event) => setForm({ ...form, confirmPassword: event.target.value })}
        />
      </label>
      {error ? <p className="login-error">{error}</p> : null}
      <div className="modal-actions">
        <button type="button" onClick={onClose}>取消</button>
        <button className="primary" type="submit" disabled={auth.busy}>确认修改</button>
      </div>
    </form>
  );
}

function App() {
  const { actions, apiStatus, auth, currentUser, metrics, state } = useApiBackedOaSystem();
  const [activeModule, setActiveModule] = useState("workbench");
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState(null);

  const filteredState = useMemo(() => {
    if (!query.trim()) return state;
    const key = query.trim();
    return {
      ...state,
      approvals: state.approvals.filter((item) => Object.values(item).join(" ").includes(key)),
      assets: state.assets.filter((item) => Object.values(item).join(" ").includes(key))
    };
  }, [query, state]);

  const workflowTemplates = useMemo(() => templatesFromDefinitions(state.workflowDefinitions), [state.workflowDefinitions]);
  const openFlow = (template) => {
    const resolvedTemplate = template
      ? workflowTemplates.find((item) => (
          item.id === template.id
          || item.id === template.templateId
          || item.serviceKey === template.serviceKey
        )) || template
      : undefined;
    setDialog({ type: "flow", title: "发起申请", template: resolvedTemplate });
  };
  const searchResults = useMemo(() => buildGlobalSearchResults({
    metrics,
    query,
    state,
    workflowTemplates
  }), [metrics, query, state, workflowTemplates]);
  const handleSearchResultClick = (result) => {
    if (result.action === "flow") {
      const template = workflowTemplates.find((item) => (
        item.id === result.templateId
        || item.serviceKey === result.serviceKey
        || item.name === result.title
      ));
      openFlow(template || result);
    } else if (result.module) {
      setActiveModule(result.module);
    }
    setQuery("");
  };
  const closeDialog = () => setDialog(null);
  const departments = useMemo(() => [...new Set((state.approvalRules || []).map((rule) => rule.department))], [state.approvalRules]);

  if (apiStatus.mode === "unauthenticated") {
    return <LoginScreen apiStatus={apiStatus} auth={auth} />;
  }
  if (apiStatus.mode === "api_required") {
    return <ApiRequiredScreen apiStatus={apiStatus} />;
  }
  if (apiStatus.mode === "first_login_required") {
    return <FirstLoginSetupScreen apiStatus={apiStatus} auth={auth} currentUser={currentUser} />;
  }

  const screen = {
    workbench: <Home metrics={metrics} onNavigate={setActiveModule} onOpenFlow={openFlow} state={filteredState} workflowTemplates={workflowTemplates} />,
    people: <People actions={actions} state={state} />,
    assets: <Assets actions={actions} onOpenAsset={() => setDialog({ type: "asset", title: "录入资产" })} state={filteredState} />,
    approvals: <Approvals actions={actions} currentUser={currentUser} onOpenFlow={() => openFlow()} state={filteredState} workflowTemplates={workflowTemplates} />,
    finance: <Finance actions={actions} onOpenFlow={openFlow} state={filteredState} workflowTemplates={workflowTemplates} />,
    resources: <Resources actions={actions} currentUser={currentUser} state={state} />,
    attendance: <Attendance actions={actions} onOpenLeave={() => setDialog({ type: "leave", title: "发起请假" })} state={state} />,
    analytics: <Analytics actions={actions} metrics={metrics} state={state} />,
    audit: <Audit actions={actions} state={state} />
  }[activeModule];

  return (
    <>
      <AppShell
        activeModule={activeModule}
        currentUser={currentUser}
        metrics={metrics}
        onNavigate={setActiveModule}
        onSearchResultClick={handleSearchResultClick}
        query={query}
        searchResults={searchResults}
        setQuery={setQuery}
      >
        <div className={`api-status api-${apiStatus.mode}`}>
          <span>{apiStatus.mode === "ready" ? "后端已连接" : apiStatus.mode === "degraded" ? "后端降级运行" : "本地演示模式"}</span>
          {apiStatus.error ? <em>{apiStatus.error}</em> : null}
          {apiStatus.source !== "mock" ? (
            <>
              <button type="button" onClick={() => setDialog({ type: "password", title: "修改密码" })}>修改密码</button>
              <button type="button" onClick={auth.logout}>退出登录</button>
            </>
          ) : null}
        </div>
        {screen}
      </AppShell>
      {dialog?.type === "flow" ? (
        <Modal title={dialog.title} onClose={closeDialog}>
          <FlowForm actions={actions} departments={departments} initialTemplate={dialog.template} onClose={closeDialog} workflowTemplates={workflowTemplates} />
        </Modal>
      ) : null}
      {dialog?.type === "asset" ? (
        <Modal title={dialog.title} onClose={closeDialog}>
          <AssetForm actions={actions} onClose={closeDialog} />
        </Modal>
      ) : null}
      {dialog?.type === "leave" ? (
        <Modal title={dialog.title} onClose={closeDialog}>
          <LeaveForm actions={actions} onClose={closeDialog} />
        </Modal>
      ) : null}
      {dialog?.type === "password" ? (
        <Modal title={dialog.title} onClose={closeDialog}>
          <ChangePasswordForm auth={auth} onClose={closeDialog} />
        </Modal>
      ) : null}
    </>
  );
}

export default App;

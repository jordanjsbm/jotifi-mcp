import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { authenticateUser, getFirestoreDoc, patchFirestoreDoc } from "./firestore-client.js";

function getCurrentYYYYMM() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function getPreviousMonth(yyyyMM) {
  let [year, month] = yyyyMM.split("-").map(Number);
  month -= 1;
  if (month < 1) {
    month = 12;
    year -= 1;
  }
  return `${year}-${String(month).padStart(2, "0")}`;
}

export function formatCOP(val) {
  const num = Number(val) || 0;
  return new Intl.NumberFormat("es-CO", {
    style: "currency",
    currency: "COP",
    maximumFractionDigits: 0
  }).format(num);
}

/**
 * Carga los datos completos del usuario desde Firestore (idéntico al flujo de App.jsx)
 */
export async function loadUserFinancialContext(idToken, uid, targetMonth) {
  const month = targetMonth || getCurrentYYYYMM();
  const [userSnap, monthSnap] = await Promise.all([
    getFirestoreDoc(`userData/${uid}`, idToken),
    getFirestoreDoc(`userData/${uid}/months/${month}`, idToken)
  ]);

  const userData = userSnap.exists ? userSnap.data : {};
  let globalDebts = Array.isArray(userData.globalDebts) ? userData.globalDebts : [];

  let globalSections = [];
  if (monthSnap.exists && Array.isArray(monthSnap.data?.globalSections)) {
    globalSections = monthSnap.data.globalSections;
  } else {
    const prevMonth = getPreviousMonth(month);
    const prevSnap = await getFirestoreDoc(`userData/${uid}/months/${prevMonth}`, idToken);
    if (prevSnap.exists && Array.isArray(prevSnap.data?.globalSections)) {
      globalSections = prevSnap.data.globalSections.map(sec => ({
        ...sec,
        expenses: (sec.expenses || []).map(e => ({ ...e, checked: false }))
      }));
    } else if (Array.isArray(userData.latestSections)) {
      globalSections = userData.latestSections.map(sec => ({
        ...sec,
        expenses: (sec.expenses || []).map(e => ({ ...e, checked: false }))
      }));
    }
  }

  // Cargar gastos compartidos del grupo activo si tiene uno
  let sharedExpenses = Array.isArray(userData.sharedExpenses) ? userData.sharedExpenses : [];
  let activeGroupName = null;
  const activeGroupId = userData.activeGroupId || null;

  if (activeGroupId) {
    try {
      const [groupDoc, groupExpDoc] = await Promise.all([
        getFirestoreDoc(`groups/${activeGroupId}`, idToken),
        getFirestoreDoc(`groups/${activeGroupId}/expenses/current`, idToken)
      ]);
      if (groupDoc.exists) {
        activeGroupName = groupDoc.data?.name || activeGroupId;
      }
      if (groupExpDoc.exists && Array.isArray(groupExpDoc.data?.list)) {
        sharedExpenses = groupExpDoc.data.list;
      }
    } catch {
      // Ignorar si el grupo ya no es accesible
    }
  }

  // Cargar préstamos compartidos si existen
  const loanIds = Array.isArray(userData.loanIds) ? userData.loanIds : [];
  const sharedLoans = [];
  if (loanIds.length > 0) {
    const loanResults = await Promise.all(
      loanIds.slice(0, 20).map(async loanId => {
        try {
          const snap = await getFirestoreDoc(`sharedLoans/${loanId}`, idToken);
          return snap.exists ? { id: loanId, ...snap.data } : null;
        } catch {
          return null;
        }
      })
    );
    sharedLoans.push(...loanResults.filter(Boolean));
  }

  return {
    month,
    userData,
    globalSections,
    globalDebts,
    sharedExpenses,
    activeGroupId,
    activeGroupName,
    sharedLoans
  };
}

/**
 * Ejecuta cualquiera de las 7 herramientas financieras de JotiFi (usado tanto por MCP como por el Bot de WhatsApp)
 */
export async function executeJotifiTool(toolName, args = {}, rawToken) {
  const { idToken, uid } = await authenticateUser(rawToken);

  switch (toolName) {
    case "jotifi_resumen_financiero": {
      const ctx = await loadUserFinancialContext(idToken, uid, args.month);
      const totalIncome = ctx.globalSections.reduce((acc, s) => acc + (Number(s.income) || 0), 0);
      const totalPlannedExpenses = ctx.globalSections.reduce(
        (acc, s) => acc + (s.expenses || []).reduce((a, e) => a + (Number(e.amount) || 0), 0),
        0
      );
      const totalPaidExpenses = ctx.globalSections.reduce(
        (acc, s) => acc + (s.expenses || []).filter(e => e.checked).reduce((a, e) => a + (Number(e.amount) || 0), 0),
        0
      );
      const remainingFree = totalIncome - totalPlannedExpenses;
      const totalDebtRemaining = ctx.globalDebts.reduce(
        (acc, d) => acc + Math.max(0, (Number(d.totalAmount) || 0) - (Number(d.paidAmount) || 0)),
        0
      );

      const summaryObj = {
        mes: ctx.month,
        metricasGenerales: {
          ingresosMensuales: totalIncome,
          ingresosFormateado: formatCOP(totalIncome),
          gastosPlaneados: totalPlannedExpenses,
          gastosPlaneadosFormateado: formatCOP(totalPlannedExpenses),
          gastosYaPagados: totalPaidExpenses,
          gastosPendientesPorPagar: totalPlannedExpenses - totalPaidExpenses,
          dineroLibreReserva: remainingFree,
          dineroLibreFormateado: formatCOP(remainingFree),
          deudaTotalRestante: totalDebtRemaining,
          deudaTotalFormateado: formatCOP(totalDebtRemaining)
        },
        bolsillos: ctx.globalSections.map(s => ({
          id: s.id,
          nombre: s.title,
          ingresoAsignado: Number(s.income) || 0,
          gastos: (s.expenses || []).map(e => ({
            id: e.id,
            nombre: e.name,
            monto: Number(e.amount) || 0,
            diaVencimiento: e.day || null,
            pagado: Boolean(e.checked)
          }))
        })),
        deudas: ctx.globalDebts.map(d => ({
          id: d.id,
          acreedor: d.name,
          montoTotal: Number(d.totalAmount) || 0,
          montoPagado: Number(d.paidAmount) || 0,
          saldoPendiente: Math.max(0, (Number(d.totalAmount) || 0) - (Number(d.paidAmount) || 0)),
          cuotaMensual: Number(d.monthlyInstallment) || 0,
          cuotasPagadas: Number(d.paidInstallments) || 0,
          totalCuotas: Number(d.totalInstallments) || 0,
          diaPago: d.paymentDay || d.limitDay || null,
          prioridad: d.priority || "urgente"
        })),
        grupoActivo: ctx.activeGroupName ? { id: ctx.activeGroupId, nombre: ctx.activeGroupName } : null,
        gastosCompartidosRecientes: ctx.sharedExpenses.slice(0, 15).map(se => ({
          id: se.id,
          descripcion: se.description,
          monto: Number(se.amount) || 0,
          pagadoPor: se.paidBy,
          beneficiarios: se.beneficiaries || [],
          fecha: se.date
        })),
        prestamosCompartidos: ctx.sharedLoans.map(l => ({
          id: l.id,
          titulo: l.title,
          montoTotal: Number(l.amount) || 0,
          montoPagado: Number(l.paidAmount) || 0,
          cuotaMensual: Number(l.monthlyInstallment) || 0,
          creador: l.creatorName,
          deudor: l.debtorName,
          estado: l.status || "activo"
        }))
      };
      return JSON.stringify(summaryObj, null, 2);
    }

    case "jotifi_crear_bolsillo": {
      const ctx = await loadUserFinancialContext(idToken, uid, args.month);
      const newSec = {
        id: `sec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        title: String(args.titulo || "Nuevo Bolsillo").trim(),
        income: Number(args.ingreso) || 0,
        expenses: []
      };
      const updatedSections = [...ctx.globalSections, newSec];
      await Promise.all([
        patchFirestoreDoc(`userData/${uid}/months/${ctx.month}`, { globalSections: updatedSections }, idToken),
        patchFirestoreDoc(`userData/${uid}`, { latestSections: updatedSections, migratedToMonthly: true }, idToken)
      ]);
      return `✅ Bolsillo "${newSec.title}" creado exitosamente en ${ctx.month} con un ingreso de ${formatCOP(newSec.income)} (ID: ${newSec.id}).`;
    }

    case "jotifi_agregar_gasto_bolsillo": {
      const ctx = await loadUserFinancialContext(idToken, uid, args.month);
      if (ctx.globalSections.length === 0) {
        throw new Error("No tienes bolsillos creados en este mes. Primero crea uno con jotifi_crear_bolsillo.");
      }
      const targetQuery = String(args.bolsillo || "").trim().toLowerCase();
      let matchedSection = ctx.globalSections.find(
        s => s.id === args.bolsillo || (s.title || "").toLowerCase() === targetQuery || (s.title || "").toLowerCase().includes(targetQuery)
      );
      if (!matchedSection) {
        matchedSection = ctx.globalSections[0];
      }
      const newExpense = {
        id: `exp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: String(args.nombreGasto || "Gasto").trim(),
        amount: Number(args.monto) || 0,
        day: args.diaVencimiento ? String(args.diaVencimiento) : "",
        checked: Boolean(args.pagado)
      };
      const updatedSections = ctx.globalSections.map(sec =>
        sec.id === matchedSection.id
          ? { ...sec, expenses: [...(sec.expenses || []), newExpense] }
          : sec
      );
      await Promise.all([
        patchFirestoreDoc(`userData/${uid}/months/${ctx.month}`, { globalSections: updatedSections }, idToken),
        patchFirestoreDoc(`userData/${uid}`, { latestSections: updatedSections }, idToken)
      ]);
      return `✅ Gasto "${newExpense.name}" por ${formatCOP(newExpense.amount)} agregado al bolsillo "${matchedSection.title}" (${ctx.month}). Estado: ${newExpense.checked ? "Pagado" : "Pendiente"}.`;
    }

    case "jotifi_marcar_gasto_pagado": {
      const ctx = await loadUserFinancialContext(idToken, uid, args.month);
      const pagado = args.pagado !== undefined ? Boolean(args.pagado) : true;
      const queryStr = String(args.gasto || "").trim().toLowerCase();
      let foundExpense = null;
      let foundSection = null;

      const updatedSections = ctx.globalSections.map(sec => ({
        ...sec,
        expenses: (sec.expenses || []).map(exp => {
          const isMatch =
            !foundExpense &&
            (exp.id === args.gasto ||
              (exp.name || "").toLowerCase() === queryStr ||
              (exp.name || "").toLowerCase().includes(queryStr));
          if (isMatch) {
            foundExpense = { ...exp, checked: pagado };
            foundSection = sec;
            return foundExpense;
          }
          return exp;
        })
      }));

      if (!foundExpense) {
        throw new Error(`No se encontró ningún gasto que coincida con "${args.gasto}" en el mes ${ctx.month}.`);
      }
      await patchFirestoreDoc(`userData/${uid}/months/${ctx.month}`, { globalSections: updatedSections }, idToken);
      return `✅ El gasto "${foundExpense.name}" (${formatCOP(foundExpense.amount)}) del bolsillo "${foundSection.title}" fue marcado como ${pagado ? "PAGADO ✅" : "PENDIENTE ⏳"}.`;
    }

    case "jotifi_agregar_deuda": {
      const ctx = await loadUserFinancialContext(idToken, uid);
      const newDebt = {
        id: `debt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: String(args.nombre || "Deuda").trim(),
        totalAmount: Number(args.montoTotal) || 0,
        monthlyInstallment: Number(args.cuotaMensual) || 0,
        totalInstallments: Number(args.totalCuotas) || 1,
        paymentDay: Number(args.diaPago) || 15,
        interestRate: String(args.tasaInteres || ""),
        paidAmount: Number(args.montoPagadoInicial) || 0,
        paidInstallments: 0,
        priority: "urgente",
        lastPaymentMonth: null
      };
      const updatedDebts = [...ctx.globalDebts, newDebt];
      await patchFirestoreDoc(`userData/${uid}`, { globalDebts: updatedDebts }, idToken);
      return `✅ Deuda "${newDebt.name}" por ${formatCOP(newDebt.totalAmount)} (cuota mensual de ${formatCOP(newDebt.monthlyInstallment)}) registrada exitosamente en JotiFi.`;
    }

    case "jotifi_abonar_deuda": {
      const ctx = await loadUserFinancialContext(idToken, uid);
      const esCuotaMensual = args.esCuotaMensual !== undefined ? Boolean(args.esCuotaMensual) : true;
      const queryStr = String(args.deuda || "").trim().toLowerCase();
      let updatedDebtItem = null;

      const updatedDebts = ctx.globalDebts.map(d => {
        const isMatch =
          !updatedDebtItem &&
          (d.id === args.deuda ||
            (d.name || "").toLowerCase() === queryStr ||
            (d.name || "").toLowerCase().includes(queryStr));
        if (!isMatch) return d;

        const paymentVal = args.montoAbono !== undefined ? Number(args.montoAbono) : Number(d.monthlyInstallment) || 0;
        updatedDebtItem = {
          ...d,
          paidAmount: (Number(d.paidAmount) || 0) + paymentVal,
          paidInstallments: esCuotaMensual ? (Number(d.paidInstallments) || 0) + 1 : Number(d.paidInstallments) || 0,
          lastPaymentMonth: ctx.month
        };
        return updatedDebtItem;
      });

      if (!updatedDebtItem) {
        throw new Error(`No se encontró ninguna deuda que coincida con "${args.deuda}".`);
      }

      await patchFirestoreDoc(`userData/${uid}`, { globalDebts: updatedDebts }, idToken);
      const restante = Math.max(0, (Number(updatedDebtItem.totalAmount) || 0) - (Number(updatedDebtItem.paidAmount) || 0));
      return `✅ Abono registrado en "${updatedDebtItem.name}". Total pagado: ${formatCOP(updatedDebtItem.paidAmount)} | Saldo pendiente: ${formatCOP(restante)}.`;
    }

    case "jotifi_agregar_gasto_compartido": {
      const ctx = await loadUserFinancialContext(idToken, uid);
      const pagadoPor = String(args.pagadoPor || "Tú").trim();
      const newExp = {
        id: `shared-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        description: String(args.descripcion || "Gasto compartido").trim(),
        amount: Number(args.monto) || 0,
        paidBy: pagadoPor,
        category: args.categoria || "Varios",
        beneficiaries: Array.isArray(args.beneficiarios) && args.beneficiarios.length > 0 ? args.beneficiarios : (ctx.userData.sharedMembers || [pagadoPor]),
        date: new Date().toISOString(),
        createdBy: uid
      };
      const newList = [newExp, ...ctx.sharedExpenses];
      if (ctx.activeGroupId) {
        await patchFirestoreDoc(`groups/${ctx.activeGroupId}/expenses/current`, { list: newList }, idToken);
      } else {
        await patchFirestoreDoc(`userData/${uid}`, { sharedExpenses: newList }, idToken);
      }
      return `✅ Gasto compartido "${newExp.description}" por ${formatCOP(newExp.amount)} (pagado por ${newExp.paidBy}) registrado en ${ctx.activeGroupName ? `el grupo "${ctx.activeGroupName}"` : "tus gastos compartidos"}.`;
    }

    default:
      throw new Error(`Herramienta desconocida: ${toolName}`);
  }
}

/**
 * Crea una instancia del servidor MCP de JotiFi vinculada al token de sesión
 */
export function createJotifiMcpServer(getDefaultToken) {
  const server = new McpServer({
    name: "jotifi-mcp",
    version: "1.0.0"
  });

  function getToken() {
    return (typeof getDefaultToken === "function" ? getDefaultToken() : getDefaultToken) || process.env.JOTIFI_TOKEN;
  }

  server.tool(
    "jotifi_resumen_financiero",
    "Obtiene el resumen financiero completo del usuario en JotiFi: ingresos mensuales, bolsillos y sus gastos (pagados/pendientes), deudas globales, gastos compartidos y préstamos.",
    {
      month: z.string().optional().describe("Mes a consultar en formato YYYY-MM (por defecto el mes actual)")
    },
    async (args) => ({
      content: [{ type: "text", text: await executeJotifiTool("jotifi_resumen_financiero", args, getToken()) }]
    })
  );

  server.tool(
    "jotifi_crear_bolsillo",
    "Crea un nuevo bolsillo (sección de presupuesto) en JotiFi.",
    {
      titulo: z.string().describe("Nombre del bolsillo (ej. 'Salario Principal', 'Hogar', 'Ahorros')"),
      ingreso: z.number().describe("Monto de ingreso asignado a este bolsillo"),
      month: z.string().optional().describe("Mes en formato YYYY-MM (por defecto el mes actual)")
    },
    async (args) => ({
      content: [{ type: "text", text: await executeJotifiTool("jotifi_crear_bolsillo", args, getToken()) }]
    })
  );

  server.tool(
    "jotifi_agregar_gasto_bolsillo",
    "Agrega un gasto planeado dentro de un bolsillo de JotiFi (puedes buscar el bolsillo por nombre o ID).",
    {
      bolsillo: z.string().describe("Nombre o ID del bolsillo donde se agregará el gasto"),
      nombreGasto: z.string().describe("Nombre o descripción del gasto (ej. 'Arriendo', 'Internet', 'Netflix')"),
      monto: z.number().describe("Valor del gasto"),
      diaVencimiento: z.union([z.string(), z.number()]).optional().describe("Día del mes en que vence el gasto (1 al 31)"),
      pagado: z.boolean().optional().describe("true si ya está pagado, false si está pendiente"),
      month: z.string().optional().describe("Mes en formato YYYY-MM (por defecto el mes actual)")
    },
    async (args) => ({
      content: [{ type: "text", text: await executeJotifiTool("jotifi_agregar_gasto_bolsillo", args, getToken()) }]
    })
  );

  server.tool(
    "jotifi_marcar_gasto_pagado",
    "Marca o desmarca un gasto de un bolsillo como pagado/liquidado en JotiFi.",
    {
      gasto: z.string().describe("Nombre o ID del gasto que quieres marcar como pagado o pendiente"),
      pagado: z.boolean().default(true).describe("true para marcar como pagado, false para marcar como pendiente"),
      month: z.string().optional().describe("Mes en formato YYYY-MM (por defecto el mes actual)")
    },
    async (args) => ({
      content: [{ type: "text", text: await executeJotifiTool("jotifi_marcar_gasto_pagado", args, getToken()) }]
    })
  );

  server.tool(
    "jotifi_agregar_deuda",
    "Registra una nueva deuda o obligación financiera en la sección Deudas de JotiFi.",
    {
      nombre: z.string().describe("Nombre del acreedor o deuda (ej. 'Tarjeta Nu', 'Crédito Vehículo')"),
      montoTotal: z.number().describe("Monto total de la deuda"),
      cuotaMensual: z.number().describe("Valor de la cuota mensual"),
      totalCuotas: z.number().optional().default(1).describe("Número total de cuotas"),
      diaPago: z.number().optional().default(15).describe("Día del mes límite de pago (1 al 31)"),
      tasaInteres: z.string().optional().default("").describe("Tasa de interés opcional (ej. '1.8%')"),
      montoPagadoInicial: z.number().optional().default(0).describe("Monto ya abonado previamente (opcional)")
    },
    async (args) => ({
      content: [{ type: "text", text: await executeJotifiTool("jotifi_agregar_deuda", args, getToken()) }]
    })
  );

  server.tool(
    "jotifi_abonar_deuda",
    "Registra el pago de una cuota mensual o un abono extra a capital en una deuda de JotiFi.",
    {
      deuda: z.string().describe("Nombre o ID de la deuda a la que se desea abonar"),
      montoAbono: z.number().optional().describe("Monto a abonar. Si se omite, se abona el valor de 1 cuota mensual fija de esa deuda."),
      esCuotaMensual: z.boolean().optional().default(true).describe("true si suma una cuota pagada, false si es un abono extra a capital")
    },
    async (args) => ({
      content: [{ type: "text", text: await executeJotifiTool("jotifi_abonar_deuda", args, getToken()) }]
    })
  );

  server.tool(
    "jotifi_agregar_gasto_compartido",
    "Registra un nuevo gasto compartido en el grupo activo del usuario (o en su lista de gastos compartidos).",
    {
      descripcion: z.string().describe("Descripción del gasto compartido (ej. 'Cena', 'Mercado', 'Servicios')"),
      monto: z.number().describe("Valor total del gasto compartido"),
      pagadoPor: z.string().describe("Nombre del miembro que pagó la cuenta"),
      categoria: z.string().optional().default("Varios").describe("Categoría del gasto (ej. 'Comida', 'Hogar', 'Transporte', 'Varios')"),
      beneficiarios: z.array(z.string()).optional().describe("Lista de nombres de quienes se benefician/dividen el gasto (por defecto todos los miembros)")
    },
    async (args) => ({
      content: [{ type: "text", text: await executeJotifiTool("jotifi_agregar_gasto_compartido", args, getToken()) }]
    })
  );

  return server;
}

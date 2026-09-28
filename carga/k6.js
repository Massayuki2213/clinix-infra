// Tráfego realista para alimentar os dashboards:
// - a clínica abre horários continuamente;
// - pacientes se cadastram, entram, listam e disputam os mesmos horários
//   (gerando conflitos reais de agendamento), às vezes cancelam;
// - alguns logins erram a senha.
//
//   docker compose --profile carga run --rm carga
//   docker compose --profile carga run --rm -e DURACAO=5m carga

import http from "k6/http";
import { check, sleep } from "k6";

const API = `${__ENV.ALVO || "http://localhost:8800"}/api`;
const DURACAO = __ENV.DURACAO || "3m";
const JSON_ = { headers: { "Content-Type": "application/json" } };
const DESCRICOES = [
  "Consulta de rotina",
  "Retorno",
  "Check-up",
  "Primeira consulta",
];

// Esperados: 401 (senha errada de propósito), 409 (conflito) e 422 (regra de negócio).
http.setResponseCallback(
  http.expectedStatuses({ min: 200, max: 299 }, 401, 409, 422),
);

export const options = {
  scenarios: {
    clinica: {
      executor: "constant-arrival-rate",
      exec: "clinicaAbreHorarios",
      rate: 1,
      timeUnit: "2s",
      duration: DURACAO,
      preAllocatedVUs: 2,
    },
    pacientes: {
      executor: "ramping-vus",
      exec: "pacienteAgenda",
      startVUs: 1,
      stages: [
        { duration: "30s", target: 10 },
        { duration: DURACAO, target: 15 },
        { duration: "20s", target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.05"],
    "http_req_duration{expected_response:true}": ["p(95)<800"],
  },
};

const autenticado = (token) => ({
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  },
});
const sortear = (lista) => lista[Math.floor(Math.random() * lista.length)];

function entrar(email, senha) {
  const resposta = http.post(
    `${API}/auth/login`,
    JSON.stringify({ email, senha }),
    JSON_,
  );
  return resposta.status === 200 ? resposta.json("token") : null;
}

export function setup() {
  return {
    clinica: [
      entrar("medica@clinix.dev", "clinix123"),
      entrar("medico@clinix.dev", "clinix123"),
    ],
  };
}

export function clinicaAbreHorarios({ clinica }) {
  // Entre 2 e 30 dias à frente, em múltiplos de 15 minutos.
  const minutos = 2 * 24 * 60 + Math.floor(Math.random() * 28 * 24 * 4) * 15;
  const data = new Date(Date.now() + minutos * 60_000);
  data.setSeconds(0, 0);
  http.post(
    `${API}/consultas`,
    JSON.stringify({
      data: data.toISOString(),
      descricao: sortear(DESCRICOES),
    }),
    autenticado(sortear(clinica)),
  );
}

// Estado por usuário virtual: cada um cria a própria conta uma única vez.
let conta = null;

export function pacienteAgenda() {
  if (!conta) {
    const email = `paciente-${crypto.randomUUID()}@carga.dev`;
    http.post(
      `${API}/usuarios`,
      JSON.stringify({
        nome: `Paciente de carga ${__VU}`,
        email,
        senha: "carga123",
      }),
      JSON_,
    );
    conta = { email, token: entrar(email, "carga123") };
  }
  // De vez em quando o paciente volta ao app (novo login) ou erra a senha.
  if (Math.random() < 0.1)
    conta.token = entrar(conta.email, "carga123") ?? conta.token;
  if (Math.random() < 0.01) entrar(conta.email, "senha-errada");

  const lista = http.get(`${API}/consultas`, autenticado(conta.token));
  check(lista, { "lista de consultas carregada": (r) => r.status === 200 });
  const consultas = lista.status === 200 ? lista.json() : [];
  const livres = consultas.filter((c) => c.status === 0);
  const agendadas = consultas.filter((c) => c.status === 1);

  if (livres.length > 0 && Math.random() < 0.6) {
    // Todos disputam os mesmos poucos horários: é assim que surgem os conflitos.
    const alvo = sortear(livres.slice(0, 3));
    http.put(
      `${API}/consultas/${alvo.id_consulta}/agendar`,
      null,
      autenticado(conta.token),
    );
  } else if (agendadas.length > 0 && Math.random() < 0.08) {
    http.put(
      `${API}/consultas/${agendadas[0].id_consulta}/cancelar`,
      JSON.stringify({ motivo_cancelamento: "Imprevisto" }),
      autenticado(conta.token),
    );
  }
  sleep(1 + Math.random() * 2);
}

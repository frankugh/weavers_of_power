function formatErrorDetail(detail, fallback) {
  if (!detail) {
    return fallback;
  }

  if (typeof detail === "string") {
    return detail;
  }

  if (Array.isArray(detail)) {
    return detail
      .map((item) => {
        if (typeof item === "string") {
          return item;
        }
        const field = Array.isArray(item?.loc) ? item.loc[item.loc.length - 1] : null;
        const message = item?.msg || JSON.stringify(item);
        return field ? `${field}: ${message}` : message;
      })
      .join("; ");
  }

  if (typeof detail === "object") {
    return detail.message || JSON.stringify(detail);
  }

  return String(detail);
}

export async function requestJson(path, options = {}) {
  const isFormData = typeof FormData !== "undefined" && options.body instanceof FormData;
  const headers = {
    ...(isFormData ? {} : { "Content-Type": "application/json" }),
    ...(options.headers || {}),
  };
  const { headers: _headers, ...requestOptions } = options;
  const response = await fetch(path, {
    ...requestOptions,
    headers,
  });

  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const payload = await response.json();
      detail = formatErrorDetail(payload.detail, detail);
    } catch {
      // fall through to default message
    }
    throw new Error(detail);
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}
